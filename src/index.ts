import { config } from "./config.js";
import { OneBotClient } from "./onebot.js";
import { HermesClient } from "./hermes.js";
import { CardRenderer } from "./renderer.js";
import type { ProgressCardData, ApprovalCardData } from "./renderer.js";
import { SkillManager } from "./skills.js";
import { ChatHistoryStore } from "./history.js";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import type {
  RouteInfo,
  Session,
  RunState,
  Approval,
  OneBotMessageEvent,
  OneBotMsgSegment,
  HermesApprovalEvent,
  OneBotGetMsgResponse,
} from "./types.js";

/**
 * QQ-Hermes 桥接主控制器。
 * 负责消息路由、会话管理、富文本解析、流式输出、
 * 审批流程、技能执行和进度通知。
 * 采用组合模式聚合 OneBotClient、HermesClient、CardRenderer 和 SkillManager。
 */
class QQBridge {
  // ── 依赖组件 ──

  private readonly onebot = new OneBotClient();
  private readonly hermes = new HermesClient();
  private readonly skillManager = new SkillManager();

  // ── 核心状态 ──

  /** 对话会话：sessionKey → Session */
  private readonly sessions = new Map<string, Session>();

  /** 活跃运行：runId → RunState */
  private readonly activeRuns = new Map<string, RunState>();

  /** 待审批记录：runId → Approval */
  private readonly pendingApprovals = new Map<string, Approval>();

  /** 已发送审批消息跟踪：runId → true（防止重复发送） */
  private readonly approvalMessageSent = new Map<string, boolean>();

  /** 群成员昵称缓存：groupId:userId → 群名片或昵称 */
  private readonly memberCache = new Map<string, string>();

  /** 聊天记录持久化存储 */
  private readonly historyStore: ChatHistoryStore;

  // ── SOUL.md ──

  private readonly soulPrompt: string;

  constructor() {
    const soulMdPath = join(config.rootDir, "SOUL.md");
    this.soulPrompt = existsSync(soulMdPath) ? readFileSync(soulMdPath, "utf-8").trim() : "";
    this.historyStore = new ChatHistoryStore(
      config.rootDir,
      config.persistHistoryMax,
      config.persistHistoryEnabled
    );
  }

  // ===================================================================
  //  公开方法
  // ===================================================================

  /** 启动桥接服务 */
  async start(): Promise<void> {
    this.log("=== QQ-Hermes Bridge 启动中 ===");
    this.log(`Bot: ${config.botName} (${config.botQq})`);
    this.log(`Hermes API: ${config.hermesApiUrl}`);
    this.log(`NapCat WS: ${config.onebotWsUrl}`);
    this.log(`进度: image=${config.progressAsImage}, rate=${config.progressRateLimitSec}s`);
    this.log(`审批: enabled=${config.approvalEnabled}, timeout=${config.approvalTimeoutSec}s`);

    this.onebot.on("_connected", () => {
      this.log("NapCat 已连接，开始监听消息");
    });

    this.onebot.on("message.group", (event) => {
      this.handleMessage(event as unknown as OneBotMessageEvent).catch((err) =>
        this.log(`handleMessage 错误: ${(err as Error).message}`)
      );
    });

    this.onebot.on("message.private", (event) => {
      this.handleMessage(event as unknown as OneBotMessageEvent).catch((err) =>
        this.log(`handleMessage 错误: ${(err as Error).message}`)
      );
    });

    this.onebot.connect();

    const shutdown = async () => {
      this.log("正在关闭...");
      this.onebot.close();
      await CardRenderer.close();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  }

  // ===================================================================
  //  访问控制
  // ===================================================================

  /** 检查用户是否为管理员 */
  private isAdmin(userId: string): boolean {
    return config.admins.has(String(userId));
  }

  /** 检查用户是否有权与 Bot 对话 */
  private canChat(route: RouteInfo): boolean {
    const uid = String(route.userId);
    if (config.blockedUsers.has(uid)) return false;
    if (config.allowedUsers.size > 0 && !config.allowedUsers.has(uid) && !this.isAdmin(uid)) {
      return false;
    }
    if (route.type === "group" && config.allowedGroups.size > 0) {
      if (!config.allowedGroups.has(String(route.groupId))) return false;
    }
    return true;
  }

  // ===================================================================
  //  触发判断
  // ===================================================================

  /** 检查是否 @了 Bot */
  private hasAtSelf(message: OneBotMsgSegment[]): boolean {
    return message.some(
      (seg) =>
        seg.type === "at" &&
        String(seg.data?.qq) === String(config.botQq)
    );
  }

  /** 提取消息中的纯文本 */
  private extractText(message: string | OneBotMsgSegment[]): string {
    if (typeof message === "string") return message;
    if (!Array.isArray(message)) return "";
    return message
      .filter((seg) => seg.type === "text")
      .map((seg) => (seg.data as { text?: string })?.text || "")
      .join("")
      .trim();
  }

  /** 检查文本中是否包含触发关键词 */
  private containsKeyword(text: string): string {
    const lower = text.toLowerCase();
    for (const kw of config.keywordTriggers) {
      if (lower.includes(kw)) return kw;
    }
    return "";
  }

  /** 判断消息是否应触发 Bot */
  private shouldTrigger(event: OneBotMessageEvent): { triggered: boolean; reason?: string } {
    if (event.message_type !== "group") return { triggered: true, reason: "private" };

    const text = this.extractText(event.message);
    const mentioned = Array.isArray(event.message) && this.hasAtSelf(event.message);
    const keywordHit = this.containsKeyword(text);

    if (mentioned) return { triggered: true, reason: "mention" };
    if (keywordHit) return { triggered: true, reason: `keyword:${keywordHit}` };
    if (!config.requireMention) return { triggered: true, reason: "bare" };

    return { triggered: false };
  }

  // ===================================================================
  //  会话管理
  // ===================================================================

  /** 获取会话键 */
  private getSessionKey(route: RouteInfo, suffix = 0): string {
    const base = route.type === "group" ? `group:${route.groupId}` : `user:${route.userId}`;
    return suffix > 0 ? `${base}:v${suffix}` : base;
  }

  /** 获取或创建会话（优先从持久化存储恢复） */
  private getSession(key: string): Session {
    if (!this.sessions.has(key)) {
      const persisted = this.historyStore.load(key);
      this.sessions.set(key, {
        history: persisted,
        sessionVersion: 0,
      });
    }
    return this.sessions.get(key)!;
  }

  /** 清除会话上下文（内存 + 持久化） */
  private clearSession(route: RouteInfo): number {
    const baseKey = this.getSessionKey(route, 0);
    const sess = this.sessions.get(baseKey);
    if (sess) {
      sess.sessionVersion = (sess.sessionVersion || 0) + 1;
      sess.history = [];
    }
    this.historyStore.clear(baseKey);
    return sess?.sessionVersion || 0;
  }

  /** 追加历史消息（内存 + 持久化） */
  private appendHistory(key: string, role: string, content: string, userId?: string): void {
    const sess = this.getSession(key);
    sess.history.push({ role, content, userId });
    const max = config.localHistoryMaxMessages * 2;
    if (sess.history.length > max) {
      sess.history = sess.history.slice(-max);
    }
    this.historyStore.save(key, sess.history);
  }

  // ===================================================================
  //  消息发送
  // ===================================================================

  /** 按最大长度切分消息 */
  private splitMessage(text: string): string[] {
    if (text.length <= config.maxMessageLength) return [text];
    const chunks: string[] = [];
    let remaining = text;
    while (remaining.length > 0) {
      if (remaining.length <= config.maxMessageLength) {
        chunks.push(remaining);
        break;
      }
      let splitIdx = remaining.lastIndexOf("\n", config.maxMessageLength);
      if (splitIdx < config.maxMessageLength * 0.3) {
        splitIdx = remaining.lastIndexOf(" ", config.maxMessageLength);
      }
      if (splitIdx < config.maxMessageLength * 0.3) {
        splitIdx = config.maxMessageLength;
      }
      chunks.push(remaining.slice(0, splitIdx));
      remaining = remaining.slice(splitIdx).trimStart();
    }
    return chunks;
  }

  /** 判断是否应压缩为合并转发 */
  private shouldCompact(text: string): boolean {
    if (config.compactLines <= 0) return false;
    const lineCount = text.split("\n").length;
    return lineCount > config.compactLines || text.length > config.compactLines * 40;
  }

  /** 以合并转发形式发送 */
  private async sendAsForward(route: RouteInfo, text: string): Promise<void> {
    const nodes = [{ name: config.botName, uin: config.botQq, content: text }];
    if (route.type === "group") {
      await this.onebot.sendGroupForwardMsg(route.groupId!, nodes);
    } else {
      await this.onebot.sendPrivateForwardMsg(route.userId, nodes);
    }
  }

  /** 发送文本回复 */
  private async sendReply(route: RouteInfo, text: string): Promise<void> {
    if (this.shouldCompact(text)) {
      await this.sendAsForward(route, text);
      return;
    }
    const chunks = this.splitMessage(text);
    for (const chunk of chunks) {
      if (route.type === "group") {
        await this.onebot.sendGroupMsg(route.groupId!, chunk);
      } else {
        await this.onebot.sendPrivateMsg(route.userId, chunk);
      }
    }
  }

  /** 发送图片（base64 格式） */
  private async sendReplyImage(route: RouteInfo, imageData: string): Promise<void> {
    try {
      if (route.type === "group") {
        await this.onebot.sendGroupImage(route.groupId!, imageData);
      } else {
        await this.onebot.sendPrivateImage(route.userId, imageData);
      }
    } catch (err) {
      this.log(`图片发送失败: ${(err as Error).message}，回退到文字`);
    }
  }

  /** 发送带引用的文本回复 */
  private async sendReplyWithMention(route: RouteInfo, text: string, userMsgId: string): Promise<void> {
    if (this.shouldCompact(text)) {
      await this.sendAsForward(route, text);
      return;
    }
    if (route.type === "group" && userMsgId) {
      const chunks = this.splitMessage(text);
      for (const chunk of chunks) {
        await this.onebot.sendGroupReply(route.groupId!, chunk, userMsgId);
      }
    } else {
      await this.sendReply(route, text);
    }
  }

  // ===================================================================
  //  图片处理
  // ===================================================================

  /** 将本地图片文件编码为 base64 */
  private localImageToBase64(filePath: string): string {
    const buffer = readFileSync(filePath);
    return `base64://${buffer.toString("base64")}`;
  }

  /** 下载远程图片并编码为 base64 */
  private async downloadImageToBase64(imageUrl: string): Promise<string> {
    const resp = await fetch(imageUrl);
    if (!resp.ok) throw new Error(`下载失败: ${resp.status}`);
    const buffer = Buffer.from(await resp.arrayBuffer());
    return `base64://${buffer.toString("base64")}`;
  }

  // ===================================================================
  //  进度跟踪
  // ===================================================================

  /** 格式化毫秒为可读时长 */
  private formatElapsed(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(0)}s`;
    return `${Math.floor(ms / 60000)}m${Math.round((ms % 60000) / 1000)}s`;
  }

  /** 检查是否应发送进度更新 */
  private shouldSendProgress(run: RunState): boolean {
    if (run.sendingProgress) return false;
    const now = Date.now();
    const elapsed = (now - run.lastProgressSent) / 1000;
    return elapsed >= config.progressRateLimitSec;
  }

  /** 发送进度卡片 */
  private async sendProgressCard(runId: string): Promise<void> {
    const run = this.activeRuns.get(runId);
    if (!run || run.sendingProgress) return;
    run.sendingProgress = true;

    const now = Date.now();
    const elapsed = this.formatElapsed(now - run.startedAt);

    const data: ProgressCardData = {
      tools: run.tools,
      currentTool: run.currentTool,
      messageDelta: run.messageDelta,
      elapsed,
    };

    try {
      if (config.progressAsImage) {
        const imagePath = await CardRenderer.renderProgressImage(data);
        if (imagePath) {
          await this.sendReplyImage(run.route, imagePath);
          run.lastProgressSent = now;
          return;
        }
      }

      // 文字回退
      const lines: string[] = [`⏳ Hermes 执行中 (${elapsed})`];
      for (const t of run.tools.slice(-8)) {
        const icon = t.error ? "❌" : "✅";
        const dur = t.duration ? ` (${this.formatElapsed(t.duration)})` : "";
        const preview = t.preview ? ` → ${t.preview.slice(0, 80)}` : "";
        lines.push(`${icon} ${t.name}${dur}${preview}`);
      }
      if (run.currentTool) {
        const preview = run.currentTool.preview ? ` → ${run.currentTool.preview.slice(0, 80)}` : "";
        lines.push(`⏳ ${run.currentTool.name}...${preview}`);
      }
      await this.sendReply(run.route, lines.join("\n"));
      run.lastProgressSent = now;
    } finally {
      run.sendingProgress = false;
    }
  }

  // ===================================================================
  //  消息格式化
  // ===================================================================

  /** 格式化 Unix 时间戳 */
  private formatTime(unixTs: number): string {
    const d = new Date(unixTs * 1000);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  /** 解析群成员名称（群名片 → QQ 昵称 → QQ 号），带缓存 */
  private async resolveMemberName(groupId: string | number, userId: string | number): Promise<string | null> {
    const key = `${groupId}:${userId}`;
    if (this.memberCache.has(key)) return this.memberCache.get(key)!;
    try {
      const info = await this.onebot.getGroupMemberInfo(groupId, userId);
      const name = info.card || info.nickname || String(userId);
      this.memberCache.set(key, name);
      return name;
    } catch {
      return null;
    }
  }

  /**
   * 将 OneBot 消息转换为 AI 可理解的富文本格式。
   * - 文本 → 原文
   * - @提及 → @昵称(QQ)
   * - 图片/视频/语音 → [图片]/[视频]/[语音]
   * - 回复引用 → 引用块（自动查询被引用消息内容）
   */
  private async formatMessage(event: OneBotMessageEvent): Promise<string> {
    const message = event.message;
    if (typeof message === "string") return message;
    if (!Array.isArray(message)) return "";

    // 收集所有需要解析昵称的 @提及
    const groupId = event.group_id;
    const atQqs: string[] = [];
    for (const seg of message) {
      if (seg.type === "at" && seg.data?.qq && seg.data.qq !== "all") {
        if (!atQqs.includes(seg.data.qq)) atQqs.push(seg.data.qq);
      }
    }

    // 并行查询所有群成员昵称
    const nameMap = new Map<string, string>();
    if (atQqs.length > 0 && groupId) {
      const results = await Promise.all(
        atQqs.map((qq) => this.resolveMemberName(groupId, qq).catch(() => null))
      );
      atQqs.forEach((qq, i) => {
        if (results[i]) nameMap.set(qq, results[i]);
      });
    }

    const parts: string[] = [];

    for (const seg of message) {
      switch (seg.type) {
        case "text":
          parts.push(seg.data?.text || "");
          break;
        case "at": {
          const qq = seg.data?.qq;
          if (qq === "all") {
            parts.push("@全体成员");
          } else {
            const name = nameMap.get(qq) || qq || "未知";
            parts.push(`@${name}(${qq})`);
          }
          break;
        }
        case "image":
          parts.push("[图片]");
          break;
        case "video":
          parts.push("[视频]");
          break;
        case "record":
          parts.push("[语音]");
          break;
        case "reply": {
          const repliedMsgId = seg.data?.id;
          if (repliedMsgId) {
            try {
              const original = await this.onebot.getMsg(repliedMsgId) as OneBotGetMsgResponse;
              if (original) {
                const senderName = original.sender?.nickname || "未知";
                const senderId = original.sender?.user_id || "";
                const time = this.formatTime(original.time);
                const content = this.extractText(original.message);
                parts.push(`> ${senderName}(${senderId}) ${time}\n> ${content}\n`);
              }
            } catch {
              parts.push("> [引用消息获取失败]\n");
            }
          }
          break;
        }
      }
    }

    return parts.join("").trim();
  }

  // ===================================================================
  //  消息处理主入口
  // ===================================================================

  /** 处理接收到的 OneBot 消息事件 */
  private async handleMessage(event: OneBotMessageEvent): Promise<void> {
    const route: RouteInfo =
      event.message_type === "group"
        ? { type: "group", groupId: String(event.group_id), userId: String(event.user_id) }
        : { type: "user", userId: String(event.user_id) };

    if (!this.canChat(route)) return;

    const triggerResult = this.shouldTrigger(event);
    if (!triggerResult.triggered) {
      // 未触发但群聊消息仍需记录到背景上下文
      if (route.type === "group") {
        const rawText = this.extractText(event.message);
        if (rawText) {
          const card = event.sender?.card?.trim();
          const nick = event.sender?.nickname?.trim();
          const senderName = card && nick && card !== nick
            ? `${card}（${nick}）`
            : card || nick || route.userId;
          const senderLabel = `${senderName} (${route.userId})`;
          this.appendHistory(this.getSessionKey(route), "user", `${senderLabel}: ${rawText}`, route.userId);
        }
      }
      return;
    }

    this.log(`触发: ${triggerResult.reason} from ${route.userId} in ${route.type}:${route.groupId || route.userId}`);

    const text = await this.formatMessage(event);
    if (!text) return;

    // 审批回复检测
    if (await this.handleApprovalReply(route, text, event.message_id)) return;

    // 停止命令
    if (text === "停止" || text.toLowerCase() === "stop") {
      await this.handleStopCommand(route);
      return;
    }

    // 清除上下文命令
    if (text === "清除上下文" || text === "新对话" || text.toLowerCase() === "new" || text.toLowerCase() === "reset") {
      const newVersion = this.clearSession(route);
      await this.sendReplyWithMention(route, `✅ 上下文已清除，开始新对话 (v${newVersion})`, event.message_id);
      return;
    }

    // 构建用户提示词
    const card = event.sender?.card?.trim();
    const nick = event.sender?.nickname?.trim();
    const senderName = card && nick && card !== nick
      ? `${card}（${nick}）`
      : card || nick || route.userId;
    const senderLabel = `${senderName} (${route.userId})`;
    const userPrompt =
      route.type === "group"
        ? `【当前消息 - 请回复这条】${senderLabel}: ${text}`
        : text;

    const sessionKey = this.getSessionKey(route);
    const session = this.getSession(sessionKey);
    const sessionVersion = session.sessionVersion || 0;
    // Hermes sessionId 按人区分；群聊日志仍按群共享
    const hermesSessionBase = route.type === "group"
      ? `group_${route.groupId}_user_${route.userId}`
      : `user_${route.userId}`;
    const hermesSessionId = sessionVersion > 0 ? `${hermesSessionBase}:v${sessionVersion}` : hermesSessionBase;

    const historyContent = route.type === "group" ? `${senderLabel}: ${text}` : text;
    this.appendHistory(sessionKey, "user", historyContent, route.userId);

    // 组装系统提示词：SOUL.md > SYSTEM_PROMPT > 默认 + 群聊上下文 + 技能列表
    const baseSystem = this.soulPrompt || config.systemPrompt || "";
    const groupContext =
      route.type === "group"
        ? `你正在 QQ 群 ${route.groupId} 中。群聊有多个成员，不同 QQ 号代表不同的人，请根据发送者标识区分。回复请简短口语化，符合 QQ 聊天风格。`
        : "";
    const skillsPrompt = this.skillManager.buildPrompt();
    const systemPrompt = [baseSystem, groupContext, skillsPrompt].filter(Boolean).join("\n\n") || undefined;

    try {
      const { runId } = await this.hermes.submitRun({
        userMessage: userPrompt,
        sessionId: hermesSessionId,
        systemPrompt,
        conversationHistory: session.history.slice(0, -1),
      });

      this.log(`run 已提交: ${runId}`);

      const runState: RunState = {
        route,
        tools: [],
        currentTool: null,
        startedAt: Date.now(),
        lastProgressSent: 0,
        sendingProgress: false,
        messageDelta: "",
        pendingText: "",
        sentTextLength: 0,
        lastTextSent: 0,
        finalOutput: "",
        userMsgId: event.message_id,
      };
      this.activeRuns.set(runId, runState);

      // 流式输出：工具调用前后自动 flush 中间文本
      const flushPendingText = async () => {
        const txt = runState.pendingText.trim();
        if (!txt) return;
        runState.pendingText = "";
        runState.sentTextLength = runState.messageDelta.length;
        runState.lastTextSent = Date.now();
        try {
          await this.sendReply(runState.route, txt);
        } catch (err) {
          this.log(`文本发送错误: ${(err as Error).message}`);
        }
      };

      const stream = this.hermes.streamEvents(runId, {
        "tool.started"(ev) {
          flushPendingText();
          runState.currentTool = {
            name: ev.tool,
            preview: ev.preview,
            startedAt: ev.timestamp * 1000,
          };
        },

        "tool.completed"(ev) {
          const tool = {
            name: ev.tool,
            duration: (ev.duration || 0) * 1000,
            error: ev.error || false,
            preview: runState.currentTool?.preview,
          };
          runState.tools.push(tool);
          runState.currentTool = null;
          flushPendingText();
        },

        "message.delta"(ev) {
          runState.messageDelta += ev.delta || "";
          runState.pendingText += ev.delta || "";

          if (bridge.shouldSendProgress(runState) && runState.tools.length > 0) {
            bridge.sendProgressCard(runId).catch((err) =>
              bridge.log(`进度发送错误: ${(err as Error).message}`)
            );
          }
        },

        "approval.request"(ev) {
          bridge.handleApprovalRequest(runId, ev as HermesApprovalEvent);
        },

        "run.completed"(ev) {
          runState.finalOutput = ev.output || "";
        },

        "run.failed"(ev) {
          runState.finalOutput = `❌ 执行失败: ${ev.error || "未知错误"}`;
        },

        "reasoning.available"(_ev) {
          // 可在此处处理推理内容
        },

        _end() {
          bridge.handleRunComplete(runId);
        },

        _error(err) {
          bridge.handleRunComplete(runId);
        },
      });

      runState.stream = stream;
    } catch (err) {
      this.log(`提交错误: ${(err as Error).message}`);
      await this.sendReplyWithMention(route, `❌ 调用 Hermes 失败: ${(err as Error).message}`, event.message_id);
    }
  }

  // ===================================================================
  //  运行完成处理
  // ===================================================================

  /** 处理运行完成：发送最终回复，执行技能标签，处理 MEDIA 标签 */
  private async handleRunComplete(runId: string): Promise<void> {
    const run = this.activeRuns.get(runId);
    if (!run) return;
    this.activeRuns.delete(runId);
    this.pendingApprovals.delete(runId);
    this.approvalMessageSent.delete(runId);

    let output = run.finalOutput || run.messageDelta;

    // 如果中间已经发过文本，通过与 messageDelta 比对找出未发送的剩余部分
    if (run.sentTextLength > 0 && run.messageDelta && output) {
      // finalOutput 可能与 messageDelta 不同（trim/格式化差异），
      // 因此用 messageDelta 当前总长度定位未发送内容更准确
      const unsentFromDelta = run.messageDelta.slice(run.sentTextLength).trim();
      if (unsentFromDelta) {
        output = unsentFromDelta;
      } else if (output.length > run.sentTextLength) {
        // messageDelta 没新内容但 finalOutput 有，取 finalOutput 尾部
        output = output.slice(run.sentTextLength).trim();
      } else {
        return; // 全部已发送
      }
    }

    if (output?.trim()) {
      // 执行技能标签
      output = await this.skillManager.processTags(output, run.route, {
        onebot: this.onebot,
        isAdmin: (uid) => this.isAdmin(uid),
      });
      this.appendHistory(this.getSessionKey(run.route), "assistant", output);

      // 解析 MEDIA: 标签，发送图片
      const mediaRegex = /MEDIA:((?:\/|https?:\/\/)[^\s\n]+)/g;
      const mediaPaths: string[] = [];
      let match: RegExpExecArray | null;

      while ((match = mediaRegex.exec(output)) !== null) {
        mediaPaths.push(match[1]);
      }

      let remainingText = output.replace(/MEDIA:(?:\/|https?:\/\/)[^\s\n]+/g, "").trim();

      for (const imgPath of mediaPaths) {
        try {
          let imageData: string;
          if (imgPath.startsWith("http://") || imgPath.startsWith("https://")) {
            imageData = await this.downloadImageToBase64(imgPath);
          } else {
            imageData = this.localImageToBase64(imgPath);
          }
          await this.sendReplyImage(run.route, imageData);
        } catch (err) {
          this.log(`图片发送失败 ${imgPath}: ${(err as Error).message}`);
        }
      }

      if (remainingText) {
        await this.sendReplyWithMention(run.route, remainingText, run.userMsgId);
      }
    }
  }

  // ===================================================================
  //  停止命令
  // ===================================================================

  /** 处理停止命令 */
  private async handleStopCommand(route: RouteInfo): Promise<void> {
    for (const [runId, run] of this.activeRuns) {
      if (
        (route.type === "group" && run.route.groupId === route.groupId) ||
        (route.type === "user" && run.route.userId === route.userId)
      ) {
        await this.hermes.stopRun(runId);
        await this.sendReply(route, "已停止当前任务 ✋");
        return;
      }
    }
    await this.sendReply(route, "当前没有正在运行的任务");
  }

  // ===================================================================
  //  审批处理
  // ===================================================================

  /** 处理审批请求 */
  private handleApprovalRequest(runId: string, ev: HermesApprovalEvent): void {
    if (!config.approvalEnabled) return;

    const run = this.activeRuns.get(runId);
    if (!run) return;

    // 防止同一 run 重复发送审批消息
    if (this.approvalMessageSent.has(runId)) {
      // 仍更新待审批数据（工具可能被多次调用）
      this.pendingApprovals.set(runId, {
        runId,
        route: run.route,
        data: ev,
        createdAt: Date.now(),
      });
      return;
    }

    const route = run.route;
    const command = ev.command || "未知命令";
    const patternKey = ev.pattern_key || "";

    const riskLevel = /rm|delete|sudo|chmod|chown|kill|reboot|shutdown/.test(patternKey)
      ? "high"
      : /curl|wget|pip|npm|apt|docker/.test(patternKey)
      ? "medium"
      : "low";

    const approval: Approval = {
      runId,
      route,
      data: ev,
      createdAt: Date.now(),
    };
    this.pendingApprovals.set(runId, approval);
    this.approvalMessageSent.set(runId, true);

    if (config.approvalTimeoutSec > 0) {
      approval.timeoutTimer = setTimeout(async () => {
        if (this.pendingApprovals.has(runId)) {
          this.pendingApprovals.delete(runId);
          this.approvalMessageSent.delete(runId);
          try {
            await this.hermes.resolveApproval(runId, "deny");
            await this.sendReply(route, `⏱️ 审批超时，已自动拒绝: ${command.slice(0, 100)}`);
          } catch { /* 忽略 */ }
        }
      }, config.approvalTimeoutSec * 1000);
    }

    this.sendApprovalCard(runId, command, riskLevel).catch((err) =>
      this.log(`审批卡片错误: ${(err as Error).message}`)
    );
  }

  /** 发送审批卡片 */
  private async sendApprovalCard(runId: string, command: string, riskLevel: string): Promise<void> {
    const approval = this.pendingApprovals.get(runId);
    if (!approval) return;

    const route = approval.route;
    const ev = approval.data;

    const data: ApprovalCardData = {
      command,
      riskLevel,
      toolName: ev.pattern_key || "",
      runId,
      preview: ev.description || "",
    };

    const imagePath = await CardRenderer.renderApprovalImage(data);

    if (imagePath) {
      await this.sendReplyImage(route, imagePath);
      await this.sendReply(
        route,
        `⚠️ 上方命令需要审批。回复 "批准" / "拒绝" / "本次允许" / "始终允许" 来处理。`
      );
    } else {
      const lines = [
        `⚠️ 需要审批`,
        data.toolName ? `模式: ${data.toolName}` : "",
        `命令: ${command.slice(0, 300)}`,
        data.preview ? `说明: ${data.preview.slice(0, 200)}` : "",
        riskLevel === "high" ? `风险: 🔴 高` : riskLevel === "medium" ? `风险: 🟡 中` : `风险: 🔵 低`,
        "",
        `回复 "批准" / "拒绝" / "本次允许" / "始终允许" 来处理`,
        `(run: ${runId.slice(-8)})`,
      ].filter(Boolean);
      await this.sendReply(route, lines.join("\n"));
    }
  }

  /** 处理审批回复 */
  private async handleApprovalReply(route: RouteInfo, text: string, msgId: string): Promise<boolean> {
    for (const [runId, approval] of this.pendingApprovals) {
      const ar = approval.route;
      if (
        (route.type === "group" && ar.groupId === route.groupId) ||
        (route.type === "user" && ar.userId === route.userId)
      ) {
        const lower = text.toLowerCase().trim();
        let choice: string | null = null;

        if (["批准", "通过", "approve", "ok", "允许"].some((k) => lower.includes(k))) {
          choice = "once";
        } else if (["拒绝", "deny", "不批准", "不允许"].some((k) => lower.includes(k))) {
          choice = "deny";
        } else if (["始终允许", "always", "始终批准", "全部允许"].some((k) => lower.includes(k))) {
          choice = "always";
        } else if (["本次允许", "session"].some((k) => lower.includes(k))) {
          choice = "session";
        }

        if (!choice) return false;

        // 仅管理员可审批
        if (!this.isAdmin(route.userId)) {
          await this.sendReplyWithMention(route, "❌ 只有管理员可以审批操作", msgId);
          return true;
        }

        if (approval.timeoutTimer) clearTimeout(approval.timeoutTimer);
        this.pendingApprovals.delete(runId);
        this.approvalMessageSent.delete(runId);

        try {
          await this.hermes.resolveApproval(runId, choice as "once" | "deny" | "always" | "session");
          const labels: Record<string, string> = {
            once: "已批准（一次）✅",
            deny: "已拒绝 ❌",
            always: "已设置始终允许 ♾️",
            session: "已允许本次会话 ✅",
          };
          await this.sendReplyWithMention(route, labels[choice] || `已处理: ${choice}`, msgId);
        } catch (err) {
          await this.sendReply(route, `审批处理失败: ${(err as Error).message}`);
        }

        return true;
      }
    }
    return false;
  }

  // ===================================================================
  //  工具方法
  // ===================================================================

  private log(msg: string, ...args: unknown[]): void {
    console.log(`[bridge] ${msg}`, ...args);
  }
}

// ── 入口 ──

const bridge = new QQBridge();
bridge.start().catch((err) => {
  console.error("致命错误:", err);
  process.exit(1);
});
