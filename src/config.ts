import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

/** 从 .env 文件加载键值对 */
function loadEnv(): Record<string, string> {
  const envPath = resolve(ROOT, ".env");
  if (!existsSync(envPath)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(envPath, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx < 0) continue;
    const key = trimmed.slice(0, idx).trim();
    const val = trimmed.slice(idx + 1).trim();
    out[key] = val;
  }
  return out;
}

/** 解析逗号分隔列表 */
function parseList(s: string | undefined): string[] {
  if (!s) return [];
  return s.split(",").map((x) => x.trim()).filter(Boolean);
}

/** 解析布尔值 */
function parseBool(s: string | undefined, def = false): boolean {
  if (s === undefined || s === "") return def;
  return s === "true" || s === "1";
}

/** 解析正整数 */
function parsePositiveInt(s: string | undefined, def = 0): number {
  const n = Number(s);
  return Number.isFinite(n) ? n : def;
}

const env = { ...loadEnv(), ...process.env };

/** 全局配置对象 */
export const config = {
  // NapCat
  onebotWsUrl: env.ONEBOT_WS_URL || "ws://127.0.0.1:3001",
  onebotAccessToken: env.ONEBOT_ACCESS_TOKEN || "",

  // Hermes
  hermesApiUrl: env.HERMES_API_URL || "http://127.0.0.1:8642",
  hermesApiKey: env.HERMES_API_KEY || "",

  // Bot 身份
  botQq: env.BOT_QQ || "",
  botName: env.BOT_NAME || "小喵",

  // 访问控制
  admins: new Set(parseList(env.ADMINS)),
  allowedGroups: new Set(parseList(env.ALLOWED_GROUPS)),
  allowedUsers: new Set(parseList(env.ALLOWED_USERS)),
  blockedUsers: new Set(parseList(env.BLOCKED_USERS)),

  // 触发方式
  requireMention: parseBool(env.REQUIRE_MENTION, true),
  keywordTriggers: parseList(env.KEYWORD_TRIGGERS).map((k) => k.toLowerCase()),

  // 进度通知
  progressRateLimitSec: parsePositiveInt(env.PROGRESS_RATE_LIMIT_SECONDS, 15),
  progressAsImage: parseBool(env.PROGRESS_AS_IMAGE, true),
  progressMaxTools: parsePositiveInt(env.PROGRESS_MAX_TOOLS, 12),

  // 消息
  maxMessageLength: parsePositiveInt(env.MAX_MESSAGE_LENGTH, 1200),
  compactLines: parsePositiveInt(env.COMPACT_LINES, -1),
  systemPrompt: env.SYSTEM_PROMPT || "",

  // 审批
  approvalEnabled: parseBool(env.APPROVAL_ENABLED, true),
  approvalTimeoutSec: parsePositiveInt(env.APPROVAL_TIMEOUT_SECONDS, 300),

  // 会话
  localHistoryMaxMessages: parsePositiveInt(env.LOCAL_HISTORY_MAX_MESSAGES, 24),
  persistHistoryEnabled: parseBool(env.PERSIST_HISTORY_ENABLED, true),
  persistHistoryMax: parsePositiveInt(env.PERSIST_HISTORY_MAX, 100),

  // 路径
  rootDir: ROOT,
};
