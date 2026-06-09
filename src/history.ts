import {existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync} from "fs";
import {join} from "path";

interface HistoryEntry {
    role: string;
    content: string;
}

/**
 * 聊天记录持久化存储。
 * 每个会话以 JSON 文件形式存储，最多保留 N 条消息，
 * 进程重启后自动恢复。
 */
export class ChatHistoryStore {
    private readonly dir: string;
    private readonly maxMessages: number;
    private readonly enabled: boolean;

    /** 内存缓存：key → 历史消息数组 */
    private readonly cache = new Map<string, HistoryEntry[]>();

    /**
     * @param rootDir 项目根目录，存储路径为 `<rootDir>/data/chat-history/`
     * @param maxMessages 每个会话最多保留的消息条数
     * @param enabled 是否启用持久化
     */
    constructor(rootDir: string, maxMessages: number, enabled: boolean) {
        this.dir = join(rootDir, "data", "chat-history");
        this.maxMessages = maxMessages;
        this.enabled = enabled;
        if (enabled) {
            mkdirSync(this.dir, {recursive: true});
        }
    }

    /**
     * 加载会话历史。
     * 优先从内存缓存读取，缓存未命中时从磁盘加载。
     */
    load(key: string): HistoryEntry[] {
        if (!this.enabled) return [];
        if (this.cache.has(key)) return this.cache.get(key)!;

        try {
            const path = this.filePath(key);
            if (existsSync(path)) {
                const raw = readFileSync(path, "utf-8");
                const data = JSON.parse(raw) as HistoryEntry[];
                if (Array.isArray(data)) {
                    this.cache.set(key, data);
                    return data;
                }
            }
        } catch {
            // 文件损坏或格式错误，忽略
        }
        return [];
    }

    /**
     * 保存会话历史。
     * 自动裁剪到 maxMessages 条，先写内存缓存再落盘。
     */
    save(key: string, history: HistoryEntry[]): void {
        if (!this.enabled) return;
        const trimmed = history.slice(-this.maxMessages);
        this.cache.set(key, trimmed);
        try {
            const path = this.filePath(key);
            writeFileSync(path, JSON.stringify(trimmed, null, 2), "utf-8");
        } catch {
            // 写入失败不阻塞主流程（磁盘满等极端情况）
        }
    }

    /**
     * 清除会话的持久化历史。
     */
    clear(key: string): void {
        if (!this.enabled) return;
        this.cache.delete(key);
        try {
            const path = this.filePath(key);
            if (existsSync(path)) unlinkSync(path);
        } catch {
            // 忽略
        }
    }

    /** 根据会话键生成安全的文件名 */
    private filePath(key: string): string {
        // 把 group:123456 转成 group_123456.json
        const safe = key.replace(/[<>:"/\\|?*]/g, "_");
        return join(this.dir, `${safe}.json`);
    }
}
