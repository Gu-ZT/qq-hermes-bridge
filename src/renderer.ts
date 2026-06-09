import { config } from "./config.js";
import { existsSync } from "fs";
import type { Browser } from "puppeteer-core";

const log = (msg: string, ...args: unknown[]) => console.log(`[renderer] ${msg}`, ...args);

/** 进度卡片渲染数据 */
export interface ProgressCardData {
  tools: Array<{ name: string; preview?: string; error: boolean; duration?: number }>;
  currentTool: { name: string; preview?: string; startedAt?: number } | null;
  messageDelta?: string;
  elapsed: string;
}

/** 审批卡片渲染数据 */
export interface ApprovalCardData {
  command: string;
  riskLevel: string;
  toolName?: string;
  runId?: string;
  preview?: string;
}

/**
 * 图片卡片渲染器。
 * 使用 Puppeteer 将 HTML 卡片渲染为 PNG 图片，通过共享目录发送给 NapCat Docker 容器。
 * 浏览器实例在首次渲染时按需启动，全局共享，进程退出时关闭。
 */
export class CardRenderer {
  private static browser: Browser | null = null;
  private static launching: Promise<Browser | null> | null = null;

  /** Chrome 可执行文件搜索路径 */
  private static readonly CHROME_PATHS = [
    "/home/qsrhf/.agent-browser/browsers/chrome-148.0.7778.97/chrome",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
    "/usr/bin/google-chrome",
  ];

  /** 获取或启动共享的 Puppeteer 浏览器实例 */
  private static async getBrowser(): Promise<Browser | null> {
    if (CardRenderer.browser?.isConnected()) return CardRenderer.browser;
    if (CardRenderer.launching) return CardRenderer.launching;

    CardRenderer.launching = (async () => {
      try {
        const puppeteer = (await import("puppeteer-core")).default;

        const executablePath = CardRenderer.CHROME_PATHS.find((p) => existsSync(p));
        if (!executablePath) {
          log("警告: 未找到 Chrome，将回退到文字模式");
          return null;
        }

        const browser = await puppeteer.launch({
          headless: true,
          executablePath,
          args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
        });
        CardRenderer.browser = browser;
        log(`浏览器已启动: ${executablePath}`);
        return browser;
      } catch (err) {
        log(`浏览器启动失败: ${(err as Error).message}`);
        return null;
      }
    })();

    const result = await CardRenderer.launching;
    CardRenderer.launching = null;
    return result;
  }

  /** 将 HTML 渲染为 PNG Buffer */
  private static async htmlToImage(html: string, width = 500): Promise<Buffer | null> {
    const browser = await CardRenderer.getBrowser();
    if (!browser) return null;

    const page = await browser.newPage();
    try {
      await page.setViewport({ width, height: 800 });
      await page.setContent(html, { waitUntil: "networkidle0" as "load" });

      const bodyHandle = await page.$("body");
      if (!bodyHandle) return null;
      const box = await bodyHandle.boundingBox();
      if (!box) return null;
      const { height } = box;
      await page.setViewport({ width, height: Math.ceil(height) + 20 });

      const screenshot = await page.screenshot({
        type: "png",
        clip: { x: 0, y: 0, width, height: Math.ceil(height) + 20 },
      });
      return Buffer.from(screenshot);
    } finally {
      await page.close();
    }
  }

  /** HTML 转义 */
  private static escapeHtml(s: unknown): string {
    return String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /** 格式化毫秒为可读时长 */
  private static formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    return `${Math.floor(ms / 60000)}m${Math.round((ms % 60000) / 1000)}s`;
  }

  /** 生成进度卡片 HTML */
  static renderProgressHtml({ tools, currentTool, messageDelta, elapsed }: ProgressCardData): string {
    const toolRows = tools.slice(-config.progressMaxTools).map((t) => {
      const icon = t.error ? "❌" : "✅";
      const dur = t.duration ? ` (${CardRenderer.formatDuration(t.duration)})` : "";
      return `<div class="tool-row">
      <span class="icon">${icon}</span>
      <span class="name">${CardRenderer.escapeHtml(t.name)}</span>
      <span class="dur">${dur}</span>
    </div>
    ${t.preview ? `<div class="preview">${CardRenderer.escapeHtml(t.preview).slice(0, 120)}</div>` : ""}`;
    });

    const currentHtml = currentTool
      ? `<div class="current-tool">
        <span class="spinner">⏳</span>
        <span class="name">${CardRenderer.escapeHtml(currentTool.name)}</span>
        ${currentTool.preview ? `<div class="preview">${CardRenderer.escapeHtml(currentTool.preview).slice(0, 120)}</div>` : ""}
      </div>`
      : "";

    const previewHtml = messageDelta
      ? `<div class="response-preview">${CardRenderer.escapeHtml(messageDelta.slice(-300))}</div>`
      : "";

    return `<!DOCTYPE html>
<html><head><style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: "PingFang SC", "Microsoft YaHei", "Noto Sans SC", sans-serif;
    background: #12101F;
    color: #2C2A3A;
    padding: 20px;
    width: 500px;
  }
  .card {
    background: #F8F0FF;
    border-radius: 12px;
    padding: 18px;
    border: 1px solid #D4A5D4;
  }
  .header {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 14px;
    padding-bottom: 10px;
    border-bottom: 1px solid #DBC4E6;
  }
  .header .icon { font-size: 22px; }
  .header .title {
    font-size: 16px;
    font-weight: 600;
    color: #FF8BA7;
  }
  .header .elapsed {
    margin-left: auto;
    font-size: 12px;
    color: #9A8EA9;
  }
  .tool-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 0;
    font-size: 13px;
  }
  .tool-row .icon { font-size: 14px; flex-shrink: 0; }
  .tool-row .name { color: #6CD4FF; font-family: monospace; }
  .tool-row .dur { color: #9A8EA9; font-size: 11px; margin-left: auto; }
  .preview {
    font-size: 11px;
    color: #9A8EA9;
    padding-left: 24px;
    margin-bottom: 4px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .current-tool {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 0;
    margin-top: 6px;
    border-top: 1px dashed #DBC4E6;
  }
  .spinner { animation: spin 1s linear infinite; font-size: 16px; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .current-tool .name { color: #F5C842; font-family: monospace; font-size: 13px; }
  .response-preview {
    margin-top: 10px;
    padding: 8px;
    background: #EADCF8;
    border-radius: 6px;
    font-size: 12px;
    color: #9A8EA9;
    max-height: 60px;
    overflow: hidden;
    word-break: break-all;
  }
  .footer {
    margin-top: 12px;
    padding-top: 8px;
    border-top: 1px solid #DBC4E6;
    font-size: 11px;
    color: #9A8EA9;
    text-align: right;
  }
</style></head><body>
  <div class="card">
    <div class="header">
      <span class="icon">🔧</span>
      <span class="title">Hermes 执行中</span>
      <span class="elapsed">${CardRenderer.escapeHtml(elapsed)}</span>
    </div>
    ${toolRows.join("\n")}
    ${currentHtml}
    ${previewHtml}
    <div class="footer">${config.botName} · SSE Progress</div>
  </div>
</body></html>`;
  }

  /** 生成审批卡片 HTML */
  static renderApprovalHtml({ command, riskLevel, toolName, runId, preview }: ApprovalCardData): string {
    const riskColors: Record<string, string> = { high: "#E94560", medium: "#F5C842", low: "#53D8FB" };
    const riskColor = riskColors[riskLevel] || riskColors.high;

    return `<!DOCTYPE html>
<html><head><style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: "PingFang SC", "Microsoft YaHei", "Noto Sans SC", sans-serif;
    background: #12101F;
    color: #2C2A3A;
    padding: 20px;
    width: 500px;
  }
  .card {
    background: #F8F0FF;
    border-radius: 12px;
    padding: 18px;
    border: 2px solid ${riskColor};
  }
  .header {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 14px;
  }
  .header .icon { font-size: 22px; }
  .header .title { font-size: 16px; font-weight: 600; color: ${riskColor}; }
  .section { margin: 10px 0; }
  .label { font-size: 12px; color: #9A8EA9; margin-bottom: 4px; }
  .value {
    font-family: monospace;
    font-size: 13px;
    background: #EADCF8;
    padding: 8px;
    border-radius: 6px;
    word-break: break-all;
    max-height: 100px;
    overflow: hidden;
  }
  .actions {
    margin-top: 14px;
    padding-top: 10px;
    border-top: 1px solid #DBC4E6;
    font-size: 13px;
    color: #9A8EA9;
    line-height: 1.8;
  }
  .actions .cmd {
    color: #6CD4FF;
    font-family: monospace;
    background: #EADCF8;
    padding: 2px 6px;
    border-radius: 4px;
  }
  .footer {
    margin-top: 10px;
    font-size: 11px;
    color: #9A8EA9;
    text-align: right;
  }
</style></head><body>
  <div class="card">
    <div class="header">
      <span class="icon">⚠️</span>
      <span class="title">需要审批</span>
    </div>
    ${toolName ? `<div class="section"><div class="label">工具</div><div class="value">${CardRenderer.escapeHtml(toolName)}</div></div>` : ""}
    <div class="section"><div class="label">命令</div><div class="value">${CardRenderer.escapeHtml(command)}</div></div>
    ${preview ? `<div class="section"><div class="label">说明</div><div class="value">${CardRenderer.escapeHtml(preview).slice(0, 200)}</div></div>` : ""}
    <div class="actions">
      回复以下内容进行审批：<br>
      <span class="cmd">批准</span> 或 <span class="cmd">通过</span> — 允许一次<br>
      <span class="cmd">拒绝</span> 或 <span class="cmd">deny</span> — 拒绝执行<br>
      <span class="cmd">本次允许</span> 或 <span class="cmd">session</span> — 本次会话内允许<br>
      <span class="cmd">始终允许</span> 或 <span class="cmd">always</span> — 永久允许该命令
    </div>
    <div class="footer">run: ${CardRenderer.escapeHtml(runId?.slice(-8))}</div>
  </div>
</body></html>`;
  }

  /** 将 PNG Buffer 编码为 OneBot base64 格式 */
  private static imageToBase64(pngBuffer: Buffer): string {
    return `base64://${pngBuffer.toString("base64")}`;
  }

  /** 渲染进度卡片为 base64 图片，返回 OneBot 可用的 base64:// 字符串 */
  static async renderProgressImage(data: ProgressCardData): Promise<string | null> {
    if (!config.progressAsImage) return null;
    try {
      const html = CardRenderer.renderProgressHtml(data);
      const buf = await CardRenderer.htmlToImage(html);
      if (!buf) return null;
      return CardRenderer.imageToBase64(buf);
    } catch (err) {
      log(`进度图片渲染失败: ${(err as Error).message}`);
      return null;
    }
  }

  /** 渲染审批卡片为 base64 图片，返回 OneBot 可用的 base64:// 字符串 */
  static async renderApprovalImage(data: ApprovalCardData): Promise<string | null> {
    try {
      const html = CardRenderer.renderApprovalHtml(data);
      const buf = await CardRenderer.htmlToImage(html);
      if (!buf) return null;
      return CardRenderer.imageToBase64(buf);
    } catch (err) {
      log(`审批图片渲染失败: ${(err as Error).message}`);
      return null;
    }
  }

  /** 关闭浏览器实例，释放资源 */
  static async close(): Promise<void> {
    if (CardRenderer.browser) {
      await CardRenderer.browser.close().catch(() => {});
      CardRenderer.browser = null;
    }
  }
}
