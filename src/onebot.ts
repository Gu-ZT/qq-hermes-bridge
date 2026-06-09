import WebSocket from "ws";
import {config} from "./config.js";
import type {ForwardNode, OneBotGetMsgResponse, OneBotGroupMemberInfo} from "./types.js";

const log = (msg: string, ...args: unknown[]) => console.log(`[onebot] ${msg}`, ...args);

/** 事件处理器类型 */
type EventHandler = (data: Record<string, unknown>) => void;

/**
 * OneBot v11 WebSocket 客户端。
 * 负责连接管理、自动重连、事件分发和所有 OneBot API 调用。
 * 单例使用，通过事件监听模式与上层通信。
 */
export class OneBotClient {
    /** WebSocket 连接实例 */
    ws: WebSocket | null = null;

    /** Bot 自身 QQ 号 */
    selfId: string;

    /** 事件处理器注册表 */
    private handlers: Map<string, EventHandler[]> = new Map();

    /** 重连定时器 */
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    /** 是否保持连接 */
    private alive = false;

    /** API 回调映射，按 echo 序列号索引 */
    private apiCallbacks: Map<string, (resp: Record<string, unknown>) => void> = new Map();

    /** API 请求序列号 */
    private apiSeq = 0;

    constructor() {
        this.selfId = config.botQq;
    }

    /**
     * 注册事件监听器。
     * @param eventType 事件类型，如 "message.group"
     * @param cb 回调函数
     */
    on(eventType: string, cb: EventHandler): this {
        if (!this.handlers.has(eventType)) this.handlers.set(eventType, []);
        this.handlers.get(eventType)!.push(cb);
        return this;
    }

    /** 建立 WebSocket 连接 */
    connect(): void {
        if (this.ws) return;
        this.alive = true;

        const url = config.onebotAccessToken
            ? `${config.onebotWsUrl}?access_token=${config.onebotAccessToken}`
            : config.onebotWsUrl;

        log(`正在连接 ${config.onebotWsUrl}`);
        this.ws = new WebSocket(url);

        this.ws.on("open", () => {
            log("已连接");
            this.emit("_connected");
        });

        this.ws.on("message", (raw) => {
            let data: Record<string, unknown>;
            try {
                data = JSON.parse(raw.toString()) as Record<string, unknown>;
            } catch {
                return;
            }

            // API 回调响应
            if (data.echo !== undefined) {
                const cb = this.apiCallbacks.get(String(data.echo));
                if (cb) {
                    this.apiCallbacks.delete(String(data.echo));
                    cb(data);
                }
                return;
            }

            // 事件分发
            if (data.post_type) {
                this.emit(String(data.post_type), data);
                if (data.post_type === "message") {
                    this.emit(`message.${String(data.message_type)}`, data);
                }
            }
        });

        this.ws.on("close", (code, reason) => {
            log(`连接断开: ${code} ${String(reason)}`);
            this.ws = null;
            this.emit("_disconnected");
            this.scheduleReconnect();
        });

        this.ws.on("error", (err) => {
            log(`连接错误: ${err.message}`);
        });
    }

    /**
     * 发送 OneBot API 请求。
     * 底层方法，所有便捷方法均通过此方法实现。
     * @param action API 动作名称
     * @param params 请求参数
     * @returns Promise<API 响应数据>
     */
    async api(action: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
        return new Promise((resolve, reject) => {
            if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
                return reject(new Error("WebSocket 未连接"));
            }
            const echo = String(++this.apiSeq);
            const timeout = setTimeout(() => {
                this.apiCallbacks.delete(echo);
                reject(new Error(`API 超时: ${action}`));
            }, 30000);

            this.apiCallbacks.set(echo, (resp: Record<string, unknown>) => {
                clearTimeout(timeout);
                if (resp.retcode === 0) {
                    resolve(resp.data as Record<string, unknown>);
                } else {
                    reject(new Error(`API 错误 ${String(resp.retcode)}: ${String(resp.msg || (resp as Record<string, unknown>).wording || "")}`));
                }
            });

            this.ws.send(JSON.stringify({action, params, echo}));
        });
    }

    /** 获取历史消息 */
    async getMsg(messageId: string | number): Promise<OneBotGetMsgResponse> {
        return this.api("get_msg", {message_id: Number(messageId)}) as unknown as Promise<OneBotGetMsgResponse>;
    }

    /** 获取群成员信息 */
    async getGroupMemberInfo(groupId: string | number, userId: string | number): Promise<OneBotGroupMemberInfo> {
        return this.api("get_group_member_info", {
            group_id: Number(groupId),
            user_id: Number(userId),
        }) as unknown as Promise<OneBotGroupMemberInfo>;
    }

    // ── 查询类 API ──

    /** 禁言群成员 */
    async setGroupBan(groupId: string | number, userId: string | number, durationSec: number): Promise<Record<string, unknown>> {
        return this.api("set_group_ban", {
            group_id: Number(groupId),
            user_id: Number(userId),
            duration: durationSec,
        });
    }

    /** 踢出群成员 */
    async setGroupKick(groupId: string | number, userId: string | number, rejectAddRequest = false): Promise<Record<string, unknown>> {
        return this.api("set_group_kick", {
            group_id: Number(groupId),
            user_id: Number(userId),
            reject_add_request: rejectAddRequest,
        });
    }

    // ── 群管理 API ──

    /** 开启/关闭全员禁言 */
    async setGroupWholeBan(groupId: string | number, enable: boolean): Promise<Record<string, unknown>> {
        return this.api("set_group_whole_ban", {
            group_id: Number(groupId),
            enable,
        });
    }

    /** 发送群聊消息 */
    async sendGroupMsg(groupId: string | number, message: string | Array<{
        type: string;
        data: Record<string, unknown>
    }>): Promise<Record<string, unknown>> {
        return this.api("send_group_msg", {
            group_id: Number(groupId),
            message,
        });
    }

    /** 发送私聊消息 */
    async sendPrivateMsg(userId: string | number, message: string | Array<{
        type: string;
        data: Record<string, unknown>
    }>): Promise<Record<string, unknown>> {
        return this.api("send_private_msg", {
            user_id: Number(userId),
            message,
        });
    }

    // ── 消息发送 API ──

    /** 发送群聊图片 */
    async sendGroupImage(groupId: string | number, imageUrl: string): Promise<Record<string, unknown>> {
        return this.sendGroupMsg(groupId, [
            {type: "image", data: {file: imageUrl}},
        ]);
    }

    /** 发送私聊图片 */
    async sendPrivateImage(userId: string | number, imageUrl: string): Promise<Record<string, unknown>> {
        return this.sendPrivateMsg(userId, [
            {type: "image", data: {file: imageUrl}},
        ]);
    }

    /** 发送群聊合并转发消息 */
    async sendGroupForwardMsg(groupId: string | number, nodes: ForwardNode[]): Promise<Record<string, unknown>> {
        return this.api("send_group_forward_msg", {
            group_id: Number(groupId),
            message: nodes.map((n) => ({
                type: "node",
                data: {
                    nickname: n.name || config.botName,
                    user_id: String(n.uin || config.botQq),
                    content: typeof n.content === "string"
                        ? [{type: "text", data: {text: n.content}}]
                        : n.content,
                },
            })),
        });
    }

    /** 发送私聊合并转发消息 */
    async sendPrivateForwardMsg(userId: string | number, nodes: ForwardNode[]): Promise<Record<string, unknown>> {
        return this.api("send_private_forward_msg", {
            user_id: Number(userId),
            message: nodes.map((n) => ({
                type: "node",
                data: {
                    nickname: n.name || config.botName,
                    user_id: String(n.uin || config.botQq),
                    content: typeof n.content === "string"
                        ? [{type: "text", data: {text: n.content}}]
                        : n.content,
                },
            })),
        });
    }

    /**
     * 发送群聊回复消息（带引用）。
     * @param groupId 群号
     * @param message 消息内容
     * @param replyMsgId 被引用的消息 ID
     */
    async sendGroupReply(groupId: string | number, message: string | Array<{
        type: string;
        data: Record<string, unknown>
    }>, replyMsgId: string | number): Promise<Record<string, unknown>> {
        const content = typeof message === "string"
            ? [{type: "text", data: {text: message}}]
            : message;
        return this.sendGroupMsg(groupId, [
            {type: "reply", data: {id: String(replyMsgId)}},
            ...content,
        ]);
    }

    /** 关闭连接，停止重连 */
    close(): void {
        this.alive = false;
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
    }

    /** 调度自动重连（3 秒延迟） */
    private scheduleReconnect(): void {
        if (!this.alive || this.reconnectTimer) return;
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            if (this.alive) this.connect();
        }, 3000);
    }

    /** 触发事件 */
    private emit(eventType: string, data?: Record<string, unknown>): void {
        const handlers = this.handlers.get(eventType) || [];
        for (const cb of handlers) {
            try {
                cb(data ?? {});
            } catch (err) {
                log(`事件处理错误 ${eventType}: ${(err as Error).message}`);
            }
        }
    }
}
