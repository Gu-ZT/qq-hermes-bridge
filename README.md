# QQ-Hermes Bridge

NapCat OneBot v11 ↔ Hermes Agent 桥接插件。通过 SSE 事件流实现实时进度通知，支持图片卡片渲染、命令审批和 AI 群管理技能。

## ✨ 特性

- **SSE 流式进度** — 异步 API + SSE 事件流实时获取 agent 执行进度
- **图片卡片** — 进度和审批请求渲染为深色风格 PNG 图片发送，避免刷屏
- **防刷屏** — 可配置的进度更新频率限制（默认 15 秒一次）
- **命令审批** — 高危命令弹出审批卡片，**仅管理员**可批准/拒绝
- **群管理技能** — AI 可通过 `[SKILL:...]` 标签调用禁言、踢出等群管理操作（仅管理员）
- **富文本消息解析** — @提及带昵称、图片/视频/语音缩略、回复引用原文
- **多发言人识别** — 群聊历史中区分不同 QQ 号，AI 知道谁说了什么
- **会话保持** — 群聊历史群组共享、私聊独立隔离，对话上下文持久化存储
- **背景上下文** — 未触发 bot 的群聊消息自动记录到对话历史，让 AI 感知群聊氛围
- **触发控制** — 支持 @提及、关键词触发、管理员列表
- **SOUL.md** — 运行目录下的 `SOUL.md` 文件自动作为系统提示词
- **自动重连** — WebSocket 断线自动重连

## 📦 安装

### 前置要求

- Node.js >= 18
- [NapCat](https://github.com/NapNeko/NapCatQQ) Docker 部署
- [Hermes Agent](https://github.com/nousresearch/hermes-agent) 运行中（API Server 模式）
- Chromium / Chrome（用于图片渲染，可选）

### 安装步骤

```bash
# 克隆仓库
git clone https://github.com/Amorter/qq-hermes-bridge.git
cd qq-hermes-bridge

# 安装依赖
npm install

# 复制并编辑配置
cp .env.example .env
nano .env

# 测试运行
npm start
```

### systemd 服务（推荐）

```bash
# 复制服务文件
cp qq-hermes-bridge.service ~/.config/systemd/user/

# 重载并启动
systemctl --user daemon-reload
systemctl --user enable --now qq-hermes-bridge.service

# 查看状态
systemctl --user status qq-hermes-bridge

# 查看日志
journalctl --user -u qq-hermes-bridge -f
```

## ⚙️ 配置

编辑 `.env` 文件：

### NapCat 连接

| 变量                    | 默认值                   | 说明                  |
|-----------------------|-----------------------|---------------------|
| `ONEBOT_WS_URL`       | `ws://127.0.0.1:3001` | NapCat WebSocket 地址 |
| `ONEBOT_ACCESS_TOKEN` | (空)                   | OneBot Access Token |

### Hermes API

| 变量               | 默认值                     | 说明                   |
|------------------|-------------------------|----------------------|
| `HERMES_API_URL` | `http://127.0.0.1:8642` | Hermes API Server 地址 |
| `HERMES_API_KEY` | (空)                     | API Key（如果配置了认证）     |

### Bot 身份

| 变量         | 默认值  | 说明       |
|------------|------|----------|
| `BOT_QQ`   | (空)  | Bot QQ 号 |
| `BOT_NAME` | `小喵` | Bot 名称   |

### 访问控制

| 变量               | 默认值 | 说明                |
|------------------|-----|-------------------|
| `ADMINS`         | (空) | 管理员 QQ 号，逗号分隔     |
| `ALLOWED_GROUPS` | (空) | 允许的群号，逗号分隔。空=全部允许 |
| `ALLOWED_USERS`  | (空) | 允许的用户 QQ 号，逗号分隔   |
| `BLOCKED_USERS`  | (空) | 屏蔽的用户 QQ 号，逗号分隔   |

### 触发方式

| 变量                 | 默认值    | 说明               |
|--------------------|--------|------------------|
| `REQUIRE_MENTION`  | `true` | 群聊中是否需要 @bot 才触发 |
| `KEYWORD_TRIGGERS` | (空)    | 关键词触发列表，逗号分隔     |

### 进度通知

| 变量                            | 默认值    | 说明            |
|-------------------------------|--------|---------------|
| `PROGRESS_RATE_LIMIT_SECONDS` | `15`   | 进度卡片发送最小间隔（秒） |
| `PROGRESS_AS_IMAGE`           | `true` | 是否以图片形式发送进度   |
| `PROGRESS_MAX_TOOLS`          | `12`   | 进度卡片最多显示的工具数量 |

### 审批

| 变量                         | 默认值    | 说明                |
|----------------------------|--------|-------------------|
| `APPROVAL_ENABLED`         | `true` | 是否启用命令审批          |
| `APPROVAL_TIMEOUT_SECONDS` | `300`  | 审批超时自动拒绝（秒），0=不超时 |

### 消息

| 变量                           | 默认值    | 说明                         |
|------------------------------|--------|----------------------------|
| `MAX_MESSAGE_LENGTH`         | `1200` | 单条消息最大长度                   |
| `SYSTEM_PROMPT`              | (内置)   | 系统提示词（会被 `SOUL.md` 覆盖，见下文） |
| `LOCAL_HISTORY_MAX_MESSAGES` | `24`   | 保留的历史消息轮数                  |
| `PERSIST_HISTORY_ENABLED`   | `true` | 是否启用对话历史持久化存储              |
| `PERSIST_HISTORY_MAX`       | `100`  | 持久化保留的最大消息数                |

### SOUL.md（系统提示词）

项目运行目录下如果存在 `SOUL.md` 文件，其内容将**自动覆盖** `SYSTEM_PROMPT` 作为系统提示词。这允许你为不同群或场景维护独立的
bot 人格文件，无需修改 `.env`。

优先级：`SOUL.md` > `SYSTEM_PROMPT` > 内置默认

### 系统提示词注入

无论使用 `SOUL.md` 还是 `SYSTEM_PROMPT`，桥接插件会自动在后面追加：

- **群聊上下文**：告知 AI 所在群号、多成员环境、不同 QQ 号代表不同人
- **可用技能列表**：见下方「技能系统」章节

## 🎮 使用方法

### 群聊触发

- `@小喵 帮我搜一下xxx` — @提及触发
- `小喵你好` — 关键词触发（如果配置了 `KEYWORD_TRIGGERS`）
- 私聊直接发消息始终触发

### 控制指令

| 指令                                | 作用           |
|-----------------------------------|--------------|
| `停止` / `stop`                     | 中断当前运行的任务    |
| `清除上下文` / `新对话` / `reset` / `new` | 清除对话历史，开始新会话 |

### 命令审批

当 agent 执行高危命令时，会弹出审批卡片（图片 + 文字）。回复对应内容处理：

| 回复                             | 效果        |
|--------------------------------|-----------|
| `批准` / `通过` / `approve` / `ok` | 允许执行一次    |
| `拒绝` / `deny`                  | 拒绝执行      |
| `始终允许` / `always`              | 本次会话内始终允许 |

**权限控制**：

- 只有 `ADMINS` 中配置的管理员可以审批或拒绝
- 非管理员回复审批命令会收到 `❌ 只有管理员可以审批操作`
- 审批支持群聊和私聊两种场景
- 超时后自动拒绝（默认 300 秒，可通过 `APPROVAL_TIMEOUT_SECONDS` 配置）

### 富文本消息解析

Bridge 会将 QQ 消息中的非文本内容自动转换为 AI 可理解的格式：

| QQ 消息类型 | 转换结果                   | 示例                                                     |
|---------|------------------------|--------------------------------------------------------|
| 文本      | 原文保留                   | `你好`                                                   |
| @提及     | `@群名片(QQ号)`            | `@古镇天Gugle(2308465862)`                                |
| @全体成员   | `@全体成员`                |                                                        |
| 图片      | `[图片]`                 |                                                        |
| 视频      | `[视频]`                 |                                                        |
| 语音      | `[语音]`                 |                                                        |
| 回复引用    | 引用块格式（自动获取被引用消息内容和发送者） | `> 古镇天Gugle(2308465862) 2026/06/06 20:50:58`<br>`> 你好` |

@提及的昵称通过 OneBot API 实时查询群成员信息（群名片优先，其次 QQ 昵称），结果会缓存，同一群内每人只查一次。

### 多发言人识别

群聊中，系统提示词会明确告知 AI：

> 群聊有多个成员，不同 QQ 号代表不同的人，请根据发送者标识区分。

每条消息在对话历史中会标注发言人：

```
Alice (111): 你好
assistant: 你好呀！
Bob (222): 天气怎么样
```

当前待回复的消息会用 `【当前消息 - 请回复这条】` 明确标记，与历史区分。

未 @bot 或命中关键词的群聊消息也会被记录到对话历史中（标记发言人身份），作为背景上下文供 AI 理解群聊氛围和对话脉络。这些消息不会触发 AI 回复，但会在后续触发时作为历史上下文的一部分传递给 Hermes。

## 🔧 技能系统

AI 可以通过在回复中插入 `[SKILL:技能名 参数...]` 标签来调用群管理技能。标签会在消息发送前被处理并移除，执行结果会附加在消息末尾。

### 可用技能

所有管理技能**仅限 `ADMINS` 中的管理员**使用，非管理员调用会被忽略并提示。

| 技能   | 格式                      | 说明                       |
|------|-------------------------|--------------------------|
| 禁言   | `[SKILL:禁言 <QQ号> <分钟>]` | 禁言指定成员，最长 30 天（43200 分钟） |
| 解除禁言 | `[SKILL:解除禁言 <QQ号>]`    | 立即解除指定成员的禁言              |
| 踢出   | `[SKILL:踢出 <QQ号>]`      | 将指定成员踢出群聊                |
| 全员禁言 | `[SKILL:全员禁言 开/关]`      | 开启或关闭全员禁言                |

### 使用示例

用户：`@小喵 把 2308465862 禁言 10 分钟`

AI 回复：

```
好的，已处理。
[SKILL:禁言 2308465862 10]
```

Bridge 处理后发送到群里的实际消息：

```
好的，已处理。

✅ 已禁言 2308465862 10 分钟
```

### 错误处理

- 参数错误 → `❌ 禁言: 时长无效，格式: 禁言 <QQ号> <时长(分钟)>`
- 非管理员调用 → `❌ 禁言: 仅管理员可用`
- 未知技能 → `❌ xxxx: 未知技能: xxxx`
- API 调用失败 → `❌ 禁言: <OneBot 错误信息>`

### 扩展技能

在 `src/skills.ts` 的 `skills` 数组中添加新条目：

```javascript
{
  name: "技能名",
  usage: "技能名 <参数1> <参数2>",
  description: "一句话描述",
  adminOnly: true,  // true 仅管理员，false 所有人
  async execute({ onebot, route, args }) {
    // 执行逻辑
    // 抛出 Error 表示失败
    // return 字符串作为成功摘要
    return "执行结果描述";
  },
}
```

## 📐 架构

```
┌─────────────┐    WebSocket     ┌──────────┐
│  QQ 用户群   │ ◄──────────────► │  NapCat   │
└─────────────┘    OneBot v11    │  Docker   │
                                 └─────┬────┘
                                       │
                                 ┌─────▼────┐
                                 │  Bridge   │
                                 │  (Node.js)│
                                 └─────┬────┘
                                       │
                    POST /v1/runs      │     GET /v1/runs/{id}/events
                    (异步提交)          │     (SSE 事件流)
                                 ┌─────▼────┐
                                 │  Hermes   │
                                 │ API Server│
                                 │  :8642    │
                                 └──────────┘
```

### 数据流

1. 用户在 QQ 发消息 → NapCat WebSocket → Bridge
2. Bridge 解析富文本（@昵称、回复引用等）
3. Bridge 构建系统提示词（`SOUL.md` + 群聊上下文 + 技能列表）
4. Bridge 调用 `POST /v1/runs` 提交异步任务（带发言人多轮历史）
5. Bridge 连接 `GET /v1/runs/{run_id}/events` SSE 事件流
6. 收到 `tool.started` / `tool.completed` → 收集进度
7. 每 15 秒（可配）渲染进度卡片（HTML → PNG）发送到 QQ
8. 收到 `approval.request` → 发送审批卡片，等管理员回复
9. 收到 `run.completed` → 解析 `[SKILL:...]` 标签并执行 → 发送最终回复

### 文件结构

```
src/
├── index.ts       # 主逻辑：消息处理、会话管理、审批、富文本解析
├── config.ts      # 配置加载（.env 环境变量）
├── hermes.ts      # Hermes API 客户端：提交任务、SSE 事件流、审批、停止
├── onebot.ts      # OneBot v11 WebSocket 客户端 + 群管理 API
├── renderer.ts    # Puppeteer 图片渲染：进度卡片、审批卡片
├── skills.ts      # 技能系统：技能定义、提示词生成、标签解析执行
├── history.ts     # 聊天记录持久化存储
└── types.d.ts     # TypeScript 类型定义
```

## 🔧 开发

详见 [DEVELOPMENT.md](./DEVELOPMENT.md)

## 📝 Changelog

### v1.2.0

- **背景上下文**：未触发 bot 的群聊消息自动记录到对话历史，AI 可感知群聊氛围
- **会话隔离调整**：群聊会话键改为群组共享（`group:{groupId}`），历史记录按群维护；Hermes sessionId 保留用户级隔离
- **历史条目增强**：对话历史新增 `userId` 字段，标识每条消息的发送者
- **TypeScript 迁移**：项目由 JavaScript 迁移至 TypeScript，新增 `types.d.ts` 类型定义

### v1.1.0

- **技能系统**：新增 `src/skills.js`，AI 可通过 `[SKILL:...]` 标签执行禁言、踢出、全员禁言等群管理操作，仅限管理员
- **管理员审批**：命令审批仅 `ADMINS` 中的管理员可操作，非管理员收到拒绝提示
- **私聊审批**：审批回复现在同时支持群聊和私聊
- **富文本消息解析**：@提及带群名片/昵称（带缓存并查），图片/视频/语音缩略为占位符，回复引用自动获取原文和发送者
- **多发言人识别**：群聊历史中每条消息标注 `昵称(QQ号)`，当前消息用 `【当前消息】` 标记，系统提示词明确说明不同 QQ 号 = 不同人
- **SOUL.md**：运行目录下存在 `SOUL.md` 时自动作为系统提示词，优先级高于 `SYSTEM_PROMPT`
- **OneBot API 扩展**：新增 `getMsg`、`getGroupMemberInfo`、`setGroupBan`、`setGroupKick`、`setGroupWholeBan`

### v1.0.0 (2025-05-13)

- 初始发布
- SSE 流式进度
- 图片卡片渲染（Puppeteer）
- 命令审批
- 会话保持
- systemd 服务支持

## 📄 License

MIT
