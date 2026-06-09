// ── OneBot v11 消息段类型 ──

export interface OneBotMsgSegmentText {
    type: "text";
    data: { text: string };
}

export interface OneBotMsgSegmentAt {
    type: "at";
    data: { qq: string };
}

export interface OneBotMsgSegmentImage {
    type: "image";
    data: { file: string; url?: string };
}

export interface OneBotMsgSegmentVideo {
    type: "video";
    data: { file: string };
}

export interface OneBotMsgSegmentRecord {
    type: "record";
    data: { file: string };
}

export interface OneBotMsgSegmentReply {
    type: "reply";
    data: { id: string };
}

export interface OneBotMsgSegmentFace {
    type: "face";
    data: { id: string };
}

/** OneBot 消息段联合类型 */
export type OneBotMsgSegment =
    | OneBotMsgSegmentText
    | OneBotMsgSegmentAt
    | OneBotMsgSegmentImage
    | OneBotMsgSegmentVideo
    | OneBotMsgSegmentRecord
    | OneBotMsgSegmentReply
    | OneBotMsgSegmentFace;

/** OneBot 发送者信息 */
export interface OneBotSender {
    user_id: number;
    nickname: string;
    card?: string;
    sex?: string;
    age?: number;
    role?: string;
}

/** OneBot 消息事件 */
export interface OneBotMessageEvent {
    post_type: "message";
    message_type: "group" | "private";
    time: number;
    self_id: number;
    sub_type: string;
    message_id: string;
    user_id: number;
    group_id?: number;
    raw_message: string;
    message: string | OneBotMsgSegment[];
    sender?: OneBotSender;
}

/** get_msg API 返回值 */
export interface OneBotGetMsgResponse {
    message_id: string;
    real_id: string;
    sender: {
        user_id: number;
        nickname: string;
        sex?: string;
        age?: number;
    };
    time: number;
    message: OneBotMsgSegment[];
    raw_message: string;
}

/** get_group_member_info API 返回值 */
export interface OneBotGroupMemberInfo {
    group_id: number;
    user_id: number;
    nickname: string;
    card: string;
    sex: string;
    age: number;
    role: string;
}

// ── 路由 ──

/** 消息来源路由：群聊或私聊 */
export interface RouteInfo {
    type: "group" | "user";
    groupId?: string;
    userId: string;
}

// ── 会话 ──

/** 对话会话 */
export interface Session {
    history: Array<{ role: string; content: string; userId?: string }>;
    sessionVersion: number;
}

// ── 运行状态 ──

/** 活跃的 Hermes 运行状态 */
export interface RunState {
    route: RouteInfo;
    tools: Array<{
        name: string;
        duration: number;
        error: boolean;
        preview?: string;
    }>;
    currentTool: {
        name: string;
        preview?: string;
        startedAt: number;
    } | null;
    startedAt: number;
    lastProgressSent: number;
    sendingProgress: boolean;
    messageDelta: string;
    pendingText: string;
    sentTextLength: number;
    lastTextSent: number;
    finalOutput: string;
    userMsgId: string;
    stream?: { abort(): void };
}

// ── 审批 ──

/** 待审批记录 */
export interface Approval {
    runId: string;
    route: RouteInfo;
    data: HermesApprovalEvent;
    createdAt: number;
    timeoutTimer?: ReturnType<typeof setTimeout>;
}

// ── Hermes SSE 事件类型 ──

export interface HermesToolStartedEvent {
    event: "tool.started";
    run_id: string;
    timestamp: number;
    tool: string;
    preview?: string;
}

export interface HermesToolCompletedEvent {
    event: "tool.completed";
    run_id: string;
    timestamp: number;
    tool: string;
    duration: number;
    error: boolean;
}

export interface HermesMessageDeltaEvent {
    event: "message.delta";
    run_id: string;
    timestamp: number;
    delta: string;
}

export interface HermesApprovalEvent {
    event: "approval.request";
    run_id: string;
    timestamp: number;
    command: string;
    pattern_key?: string;
    description?: string;
}

export interface HermesRunCompletedEvent {
    event: "run.completed";
    run_id: string;
    timestamp: number;
    output: string;
}

export interface HermesRunFailedEvent {
    event: "run.failed";
    run_id: string;
    timestamp: number;
    error: string;
}

export interface HermesReasoningEvent {
    event: "reasoning.available";
    run_id: string;
    timestamp: number;
    text: string;
}

/** Hermes SSE 事件联合类型 */
export type HermesSSEEvent =
    | HermesToolStartedEvent
    | HermesToolCompletedEvent
    | HermesMessageDeltaEvent
    | HermesApprovalEvent
    | HermesRunCompletedEvent
    | HermesRunFailedEvent
    | HermesReasoningEvent;

/** Hermes SSE 事件回调映射 */
export interface HermesEventCallbacks {
    "tool.started"?: (ev: HermesToolStartedEvent) => void;
    "tool.completed"?: (ev: HermesToolCompletedEvent) => void;
    "message.delta"?: (ev: HermesMessageDeltaEvent) => void;
    "approval.request"?: (ev: HermesApprovalEvent) => void;
    "run.completed"?: (ev: HermesRunCompletedEvent) => void;
    "run.failed"?: (ev: HermesRunFailedEvent) => void;
    "reasoning.available"?: (ev: HermesReasoningEvent) => void;
    _end?: () => void;
    _error?: (err: Error) => void;
    _any?: (ev: HermesSSEEvent) => void;
}

// ── 技能系统 ──

/** 技能执行上下文 */
export interface SkillExecuteContext {
    onebot: import("./onebot.js").OneBotClient;
    route: RouteInfo;
    args: string[];
}

/** 技能定义 */
export interface Skill {
    name: string;
    usage: string;
    description: string;
    adminOnly: boolean;

    execute(ctx: SkillExecuteContext): Promise<string>;
}

/** 审批选择 */
export type ApprovalChoice = "once" | "deny" | "always" | "session";

/** 技能执行结果 */
export type SkillResult =
    | { ok: true; skill: string; message: string }
    | { ok: false; skill: string; error: string };

// ── OneBot API 辅助类型 ──

/** 合并转发消息节点 */
export interface ForwardNode {
    name?: string;
    uin?: string | number;
    content: string | Array<{ type: string; data: Record<string, unknown> }>;
}
