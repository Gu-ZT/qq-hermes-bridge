import type { RouteInfo, Skill, SkillExecuteContext, SkillResult } from "./types.js";
import type { OneBotClient } from "./onebot.js";

/**
 * 技能管理器。
 * 定义 AI 可调用的群管理技能，生成本文提示词，解析并执行 AI 输出中的技能标签。
 * 所有管理技能仅限配置的 ADMIN 使用。
 */
export class SkillManager {
  /** 已注册的技能列表 */
  private skills: Skill[];

  /** 技能名 → 技能定义的快速索引 */
  private skillIndex: Map<string, Skill>;

  /** 技能标签匹配正则：[SKILL:名称 参数...] */
  private static readonly SKILL_TAG_RE = /\[SKILL:([^\]]+)\]/g;

  constructor() {
    this.skills = [
      {
        name: "禁言",
        usage: "禁言 <QQ号> <时长(分钟)>",
        description: "禁言指定群成员，最长 30 天（43200 分钟）",
        adminOnly: true,
        execute: this.executeMute.bind(this),
      },
      {
        name: "解除禁言",
        usage: "解除禁言 <QQ号>",
        description: "解除指定成员的禁言",
        adminOnly: true,
        execute: this.executeUnmute.bind(this),
      },
      {
        name: "踢出",
        usage: "踢出 <QQ号>",
        description: "将指定成员踢出群聊",
        adminOnly: true,
        execute: this.executeKick.bind(this),
      },
      {
        name: "全员禁言",
        usage: "全员禁言 <开/关>",
        description: "开启或关闭全员禁言",
        adminOnly: true,
        execute: this.executeWholeBan.bind(this),
      },
    ];

    this.skillIndex = new Map(this.skills.map((s) => [s.name, s]));
  }

  // ── 技能执行方法 ──

  /** 从参数中提取纯数字 QQ 号 */
  private extractQq(arg: string | undefined): string | null {
    if (!arg) return null;
    const match = String(arg).match(/\((\d+)\)$/);
    return match ? match[1] : String(arg).replace(/\D/g, "") || null;
  }

  /** 解析正整数 */
  private parsePositiveInt(s: string | undefined, max = Infinity): number | null {
    const n = parseInt(s ?? "", 10);
    if (!Number.isFinite(n) || n <= 0) return null;
    return Math.min(n, max);
  }

  /** 执行禁言技能 */
  private async executeMute({ onebot, route, args }: SkillExecuteContext): Promise<string> {
    const qq = this.extractQq(args[0]);
    if (!qq) throw new Error("缺少 QQ 号，格式: 禁言 <QQ号> <时长(分钟)>");
    const minutes = this.parsePositiveInt(args[1], 43200);
    if (!minutes) throw new Error("时长无效，格式: 禁言 <QQ号> <时长(分钟)>");
    await onebot.setGroupBan(route.groupId!, qq, minutes * 60);
    return `已禁言 ${qq} ${minutes} 分钟`;
  }

  /** 执行解除禁言技能 */
  private async executeUnmute({ onebot, route, args }: SkillExecuteContext): Promise<string> {
    const qq = this.extractQq(args[0]);
    if (!qq) throw new Error("缺少 QQ 号，格式: 解除禁言 <QQ号>");
    await onebot.setGroupBan(route.groupId!, qq, 0);
    return `已解除 ${qq} 的禁言`;
  }

  /** 执行踢出技能 */
  private async executeKick({ onebot, route, args }: SkillExecuteContext): Promise<string> {
    const qq = this.extractQq(args[0]);
    if (!qq) throw new Error("缺少 QQ 号，格式: 踢出 <QQ号>");
    await onebot.setGroupKick(route.groupId!, qq);
    return `已将 ${qq} 踢出群聊`;
  }

  /** 执行全员禁言技能 */
  private async executeWholeBan({ onebot, route, args }: SkillExecuteContext): Promise<string> {
    const arg = String(args[0] || "").trim();
    if (["开", "开启", "启用", "on", "true", "1"].includes(arg)) {
      await onebot.setGroupWholeBan(route.groupId!, true);
      return "已开启全员禁言";
    }
    if (["关", "关闭", "禁用", "off", "false", "0"].includes(arg)) {
      await onebot.setGroupWholeBan(route.groupId!, false);
      return "已关闭全员禁言";
    }
    throw new Error("参数无效，请使用 开 或 关");
  }

  // ── 公共方法 ──

  /**
   * 构建技能列表提示词，注入到系统提示词中。
   * 按「公共技能」和「管理技能（仅管理员）」分组展示。
   */
  buildPrompt(): string {
    if (this.skills.length === 0) return "";

    const adminSkills = this.skills.filter((s) => s.adminOnly);
    const publicSkills = this.skills.filter((s) => !s.adminOnly);

    const lines: string[] = ["## 可用技能"];

    if (publicSkills.length > 0) {
      lines.push("");
      for (const s of publicSkills) {
        lines.push(`- \`${s.usage}\` — ${s.description}`);
      }
    }

    if (adminSkills.length > 0) {
      lines.push("");
      lines.push("### 管理技能（仅管理员可用）");
      for (const s of adminSkills) {
        lines.push(`- \`${s.usage}\` — ${s.description}`);
      }
    }

    lines.push("");
    lines.push("调用格式：在回复中插入 `[SKILL:技能名 参数...]`，标签会在发送前被处理并移除。");
    lines.push("注意：参数中的 QQ 号使用纯数字格式，多个技能可在一段话中同时调用。");

    return lines.join("\n");
  }

  /**
   * 解析并执行 AI 输出中的 [SKILL:...] 标签。
   * 全部标签执行完毕后从文本中移除，并在末尾附加执行摘要。
   *
   * @param output AI 生成的输出文本
   * @param route 消息来源路由
   * @param deps 依赖项（onebot 客户端和管理员检查函数）
   * @returns 清理后的文本（含执行摘要）
   */
  async processTags(
    output: string,
    route: RouteInfo,
    deps: { onebot: OneBotClient; isAdmin: (userId: string) => boolean }
  ): Promise<string> {
    const { onebot, isAdmin } = deps;

    // 收集所有技能标签
    const tags: Array<{ raw: string; content: string; index: number }> = [];
    let match: RegExpExecArray | null;
    SkillManager.SKILL_TAG_RE.lastIndex = 0;
    while ((match = SkillManager.SKILL_TAG_RE.exec(output)) !== null) {
      tags.push({ raw: match[0], content: match[1], index: match.index });
    }

    if (tags.length === 0) return output;

    // 逐个解析并执行
    const results: SkillResult[] = [];
    for (const tag of tags) {
      const parts = tag.content.trim().split(/\s+/);
      const skillName = parts[0];
      const args = parts.slice(1);

      const skill = this.skillIndex.get(skillName);
      if (!skill) {
        results.push({ ok: false, skill: skillName, error: `未知技能: ${skillName}` });
        continue;
      }

      // 管理员权限检查
      if (skill.adminOnly && !isAdmin(route.userId)) {
        results.push({ ok: false, skill: skillName, error: "仅管理员可用" });
        continue;
      }

      try {
        const msg = await skill.execute({ onebot, route, args });
        results.push({ ok: true, skill: skillName, message: msg });
      } catch (err) {
        results.push({ ok: false, skill: skillName, error: (err as Error).message });
      }
    }

    // 从文本中移除所有技能标签
    let cleaned = output;
    for (const tag of tags) {
      cleaned = cleaned.replace(tag.raw, "");
    }
    cleaned = cleaned.replace(/ {2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim();

    // 附加执行摘要
    const summaryLines: string[] = [];
    for (const r of results) {
      if (r.ok) {
        summaryLines.push(`✅ ${r.message}`);
      } else {
        summaryLines.push(`❌ ${r.skill}: ${r.error}`);
      }
    }
    if (summaryLines.length > 0) {
      cleaned = cleaned + "\n\n" + summaryLines.join("\n");
    }

    return cleaned;
  }
}
