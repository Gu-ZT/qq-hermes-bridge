# 开发文档

## 项目结构

```
qq-hermes-bridge/
├── src/
│   ├── index.ts        # 主入口：消息处理、会话管理、审批、富文本解析、流式输出
│   ├── config.ts       # 配置加载（.env 解析）
│   ├── onebot.ts       # OneBot v11 WebSocket 客户端 + 群管理 API
│   ├── hermes.ts       # Hermes API 客户端（/v1/runs + SSE）
│   ├── renderer.ts     # HTML → PNG 图片渲染（Puppeteer）
│   ├── skills.ts       # AI 技能系统：群管理技能定义、提示词生成、标签解析执行
│   ├── history.ts      # 聊天记录持久化存储
│   └── types.d.ts      # TypeScript 类型定义
├── .env.example        # 配置模板
├── .env                # 实际配置（不提交）
├── package.json
├── tsconfig.json       # TypeScript 配置
├── qq-hermes-bridge.service  # systemd 服务文件
├── README.md           # 用户文档
├── DEVELOPMENT.md      # 开发文档（本文件）
├── SOUL.md             # 可选：自定义系统提示词，优先级高于 SYSTEM_PROMPT
└── LICENSE
```

## 核心模块

### config.ts

从 `.env` 文件加载配置，合并 `process.env`。导出 `config` 对象。

```ts
import { config } from "./config.js";

console.log(config.botQq); // "123456789"
```

### onebot.ts

OneBot v11 WebSocket 客户端。支持：

- 连接/重连
- 事件监听（`message.group`, `message.private` 等）
- 消息发送（文本、图片、回复、合并转发）
- 群管理（禁言、踢出、全员禁言）
- 消息查询（获取历史消息、群成员信息）

```js
const onebot = new OneBotClient();
onebot.on("message.group", (event) => {
    console.log(event.message);
});
onebot.connect();

// 消息发送
await onebot.sendGroupMsg(groupId, "hello");
await onebot.sendGroupReply(groupId, "hello", replyMsgId);
await onebot.sendGroupForwardMsg(groupId, nodes);

// 群管理
await onebot.setGroupBan(groupId, userId, 600);  // 禁言 10 分钟
await onebot.setGroupKick(groupId, userId);
await onebot.setGroupWholeBan(groupId, true);

// 查询
await onebot.getMsg(messageId);
await onebot.getGroupMemberInfo(groupId, userId);
```

### hermes.ts

Hermes API 客户端。核心功能：

- `submitRun()` — POST `/v1/runs`，异步提交任务（带会话历史）
- `streamEvents()` — GET `/v1/runs/{id}/events`，SSE 事件流
- `resolveApproval()` — POST `/v1/runs/{id}/approval`
- `stopRun()` — POST `/v1/runs/{id}/stop`

```js
const hermes = new HermesClient();
const {runId} = await hermes.submitRun({
    userMessage: "帮我搜一下天气",
    sessionId: "group:123456",
    systemPrompt: "你是一个...",
    conversationHistory: [{role: "user", content: "..."}, ...],
});

hermes.streamEvents(runId, {
    "tool.started"(ev) { console.log("tool:", ev.tool); },
    "tool.completed"(ev) { console.log("done:", ev.tool); },
    "message.delta"(ev) { /* 流式文本增量 */ },
    "approval.request"(ev) { /* 审批请求 */ },
    "run.completed"(ev) { console.log("result:", ev.output); },
    "run.failed"(ev) { console.log("error:", ev.error); },
    _end() { console.log("stream closed"); },
});
```

### renderer.ts

Puppeteer 渲染器，将 HTML 卡片渲染为 PNG。浏览器按需启动（首次渲染时），共享实例，关闭时自动清理。

- `renderProgressHtml()` — 生成进度卡片 HTML
- `renderApprovalHtml()` — 生成审批卡片 HTML
- `renderProgressImage()` — 渲染进度卡片为文件路径
- `renderApprovalImage()` — 渲染审批卡片为文件路径
- `htmlToImage()` — 底层 HTML → PNG buffer
- `saveImageForOnebot()` — 保存到共享目录并返回 Docker 路径
- `closeRenderer()` — 关闭浏览器

### skills.ts

AI 技能系统，允许 Hermes 通过 `[SKILL:...]` 标签在回复中调用群管理操作。

核心导出：

- `skills` — 技能定义数组
- `buildSkillsPrompt()` — 生成技能列表提示词（注入 system prompt）
- `processSkillTags(output, route, deps)` — 解析并执行 `[SKILL:...]` 标签，返回清理后的文本

技能定义结构：

```js
{
  name: "禁言",
  usage: "禁言 <QQ号> <时长(分钟)>",
  description: "禁言指定群成员",
  adminOnly: true,
  async execute({ onebot, route, args }) {
    // 抛出 Error = 失败，return 字符串 = 成功摘要
    return "已禁言 123456 10 分钟";
  },
}
```

详见 [README.md § 技能系统](./README.md#-技能系统)。

### history.ts

聊天记录持久化存储模块。将对话历史以 JSON 文件形式保存到磁盘，支持重启后恢复。

```ts
const store = new ChatHistoryStore(rootDir, maxMessages, enabled);

// 保存会话历史
store.save(sessionKey, history);

// 加载会话历史
const history = store.load(sessionKey);

// 清除会话历史
store.clear(sessionKey);
```

特性：
- 每个 session 独立文件存储
- 可配置最大保留消息数（`PERSIST_HISTORY_MAX`）
- 可通过 `PERSIST_HISTORY_ENABLED` 开关
- 仅在调用 `save` 时写入磁盘，减少 I/O

### index.ts

主入口，负责：

1. **消息处理** — 接收 OneBot 消息事件，触发检查，提交到 Hermes
2. **富文本解析** — @提及带昵称（缓存查群名片）、图片/视频/语音缩略、回复引用原文
3. **多发言人识别** — 群聊历史标注 `昵称(QQ号)`，当前消息标记 `【当前消息】`
4. **背景上下文** — 未触发 bot 的群聊消息自动记录到对话历史，作为 AI 感知群聊氛围的背景
5. **系统提示词** — 组合 SOUL.md + 群聊上下文 + 技能列表
6. **进度跟踪** — 监听 SSE 事件，维护每个 run 的状态
7. **流式输出** — 工具调用前后立即 flush 中间文本到群聊
8. **进度卡片** — 频率限制，渲染图片或文字发送
9. **审批处理** — 接收审批请求，发送审批卡片，仅管理员可操作
10. **技能执行** — 解析 AI 输出中的 `[SKILL:...]` 标签并执行
11. **会话管理** — 群聊历史群组共享（`group:{groupId}`），私聊独立隔离；Hermes sessionId 按用户区分；历史条目带 `userId` 标识发送者
12. **持久化存储** — 通过 `ChatHistoryStore` 将对话历史持久化到磁盘，重启后自动恢复
13. **长消息压缩** — 超阈值自动转为合并转发

## SSE 事件格式

Hermes API Server 通过 `/v1/runs/{id}/events` 发送以下事件：

### tool.started

```json
{
  "event": "tool.started",
  "run_id": "run_abc123",
  "timestamp": 1715555555.123,
  "tool": "terminal",
  "preview": "curl -s https://api.example.com"
}
```

### tool.completed

```json
{
  "event": "tool.completed",
  "run_id": "run_abc123",
  "timestamp": 1715555556.456,
  "tool": "terminal",
  "duration": 1.333,
  "error": false
}
```

### message.delta

```json
{
  "event": "message.delta",
  "run_id": "run_abc123",
  "timestamp": 1715555557.789,
  "delta": "这是回复的"
}
```

### approval.request

```json
{
  "event": "approval.request",
  "run_id": "run_abc123",
  "timestamp": 1715555558.012,
  "command": "sudo rm -rf /tmp/test",
  "pattern_key": "terminal:dangerous",
  "pattern_keys": ["terminal:dangerous", "terminal:rm"],
  "description": "删除文件或目录",
  "choices": ["once", "session", "always", "deny"]
}
```

### run.completed

```json
{
  "event": "run.completed",
  "run_id": "run_abc123",
  "timestamp": 1715555559.345,
  "output": "最终回复文本...",
  "usage": {
    "input_tokens": 1500,
    "output_tokens": 300,
    "total_tokens": 1800
  }
}
```

### run.failed

```json
{
  "event": "run.failed",
  "run_id": "run_abc123",
  "timestamp": 1715555560.678,
  "error": "Agent iteration limit exceeded"
}
```

## 流式输出机制

AI 在工具调用间隙产生的文本会实时发送到群聊，而非等全部完成：

```
message.delta 事件 → 累积到 pendingText

tool.started → flushPendingText()  ← AI 调工具前，先发它刚才写的文字
tool.completed → flushPendingText() ← 工具执行完，发过程文字
run.completed → 只发剩余未发部分（output.slice(sentTextLength)）
```

## 长消息压缩

当消息超过 `COMPACT_LINES` 配置阈值时，自动转为合并转发（聊天记录卡片）：

```
行数 > COMPACT_LINES         → 合并转发
字数 > COMPACT_LINES × 40    → 合并转发
COMPACT_LINES ≤ 0            → 禁用（默认 -1）
```

群聊调用 `send_group_forward_msg`，私聊调用 `send_private_forward_msg`。

## 防刷屏机制

进度发送使用互斥锁 + 时间限制双重保护：

```
message.delta 事件
    │
    ▼
shouldSendProgress()?
    │
    ├─ sendingProgress == true? → 跳过（正在发送中）
    ├─ 距上次发送 < PROGRESS_RATE_LIMIT_SECONDS? → 跳过（频率限制）
    └─ 通过 → sendProgressCard()
                │
                ├─ 设置 sendingProgress = true（锁定）
                ├─ 渲染图片
                ├─ 发送
                └─ finally: sendingProgress = false（解锁）
```

## 图片渲染

使用 `puppeteer-core` + 系统 Chrome/Chromium：

1. 生成 HTML（粉紫狐狸主题卡片）
2. Puppeteer 启动 headless Chrome
3. 设置 viewport 宽度 500px
4. 注入 HTML
5. 自适应内容高度
6. 截图 PNG
7. 保存到宿主机共享目录（`/home/qsrhf/napcat/config/hermes-images/`）
8. 返回 Docker 容器内路径（`/app/napcat/config/hermes-images/`）
9. 通过 OneBot `file://` 协议发送

浏览器实例全局共享，首次渲染时启动，进程退出时关闭。图片目录最多保留 50 张，超量自动清理旧文件。

Chrome 路径查找顺序：

1. `~/.agent-browser/browsers/chrome-*/chrome`
2. `/usr/bin/chromium-browser`
3. `/usr/bin/chromium`
4. `/usr/bin/google-chrome`

## 审批流程

```
approval.request SSE 事件
    │
    ▼
handleApprovalRequest() → 渲染审批卡片 + 文字提示 → 发送到群/私聊
    │
    ▼
管理员回复 "批准" / "拒绝" / "始终允许"
    │
    ▼
handleApprovalReply() → isAdmin() 检查 → resolveApproval()
```

关键点：
- 仅 `ADMINS` 列表中的用户可以审批
- 非管理员回复审批命令收到拒绝提示，不会触发新对话
- 私聊和群聊均可审批
- 超时自动拒绝（默认 300 秒）

## 添加新功能

### 添加新的 SSE 事件处理

在 `index.ts` 的 `hermes.streamEvents()` 回调中添加：

```js
"new.event.type"(ev) {
  // 处理新事件
},
```

### 添加新的触发方式

修改 `shouldTrigger()` 函数：

```js
function shouldTrigger(event) {
    // 现有逻辑...

    // 新增：特定指令触发
    const text = extractText(event.message);
    if (text.startsWith("/")) return {triggered: true, reason: "command"};

    return {triggered: false};
}
```

### 添加新技能

在 `skills.ts` 的 `skills` 数组中添加新条目：

```js
{
  name: "技能名",
  usage: "技能名 <参数1> <参数2>",
  description: "一句话描述",
  adminOnly: true,  // true 仅管理员可用
  async execute({ onebot, route, args }) {
    // 执行逻辑，return 成功描述，throw Error 表示失败
  },
}
```

### 自定义卡片样式

修改 `renderer.ts` 中 `renderProgressHtml()` 和 `renderApprovalHtml()` 的 CSS。

## 调试

```bash
# 前台运行查看日志
cd ~/.hermes/plugins/qq-hermes-bridge
npm start

# 查看 systemd 服务日志
journalctl --user -u qq-hermes-bridge -f

# 查看错误
journalctl --user -u qq-hermes-bridge -p err

# 检查 NapCat 连接
docker logs napcat --tail 20

# 检查 Hermes API
curl -s http://127.0.0.1:8642/health

# 测试 Puppeteer 渲染
node -e "
import puppeteer from 'puppeteer-core';
const b = await puppeteer.launch({
  headless: 'new',
  executablePath: '/usr/bin/chromium-browser',
  args: ['--no-sandbox']
});
const p = await b.newPage();
await p.setContent('<h1>Test</h1>');
await p.screenshot({path: '/tmp/test.png'});
await b.close();
console.log('OK');
"
```

## 依赖

| 包                | 用途                        |
|------------------|---------------------------|
| `ws`             | OneBot v11 WebSocket 客户端  |
| `puppeteer-core` | HTML → PNG 渲染（不捆绑 Chrome） |
| `tsx`            | TypeScript 执行器（开发/运行）   |
| `typescript`     | TypeScript 编译器（类型检查）    |

## 注意事项

- NapCat 运行在 Docker 中，图片通过宿主机共享目录传递，使用 `file://` 协议发送
- Puppeteer 首次渲染有冷启动延迟（~2-3秒），后续复用浏览器实例
- SSE 连接是长连接，网络断开会自动触发 run 完成处理
- 审批超时后自动 deny，不会无限等待
- `SOUL.md` 优先级高于 `SYSTEM_PROMPT`，启动时读取一次
- @提及的昵称通过 `get_group_member_info` API 查询，结果在进程生命周期内缓存
- 群管理技能仅限 `ADMINS` 中的管理员，非管理员调用自动拒绝
- 群聊会话键（sessionKey）为群组共享（`group:{groupId}`），历史记录所有成员可见；Hermes sessionId 按用户隔离（`group:{groupId}:user:{userId}`），AI 对话上下文每人独立
- 未触发 bot 的群聊消息默认记录到背景上下文，帮助 AI 理解群聊氛围；每条历史消息带 `userId` 字段标识发送者
- 依赖 `tsx` 直接执行 TypeScript 源文件，无需编译步骤
