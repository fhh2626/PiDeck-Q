import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";

export type RpcResponse = {
  id?: string;
  type: "response";
  command: string;
  success: boolean;
  data?: unknown;
  error?: string;
};

type PendingRequest = {
  resolve: (response: RpcResponse) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

export class PiRpcClient extends EventEmitter {
  /**
   * 尚未遇到换行的行片段。只在新到的解码文本里找换行，换行到达时才 join：
   * 若每个 chunk 都拼接整个累积缓冲并从头 indexOf，数十 MB 的单行响应
   * （如 get_messages）会退化为 O(n²)，阻塞主进程数秒。
   */
  private partialLine: string[] = [];
  private readonly decoder = new StringDecoder("utf8");
  private readonly pending = new Map<string, PendingRequest>();
  private closed = false;

  constructor(
    private readonly stdin: NodeJS.WritableStream,
    stdout: NodeJS.ReadableStream,
  ) {
    super();
    stdout.on("data", chunk => this.consumeChunk(chunk));
    stdout.on("end", () => this.consumeEnd());
  }

  request(command: Record<string, unknown>, timeoutMs = 30_000): Promise<RpcResponse> {
    if (this.closed) {
      return Promise.reject(new Error("RPC client is closed"));
    }
    const id = String(command.id ?? randomUUID());
    const payload = { ...command, id };

    const promise = new Promise<RpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // 错误文本带超时时长，方便 toast/诊断卡直接看出是等待过久而非连接断开
        reject(new Error(`RPC command timed out after ${timeoutMs}ms: ${String(command.type)}`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });
    });

    this.write(payload);
    return promise;
  }

  notify(command: Record<string, unknown>) {
    if (this.closed) return;
    this.write(command);
  }

  /** 直接向 pi 的 stdin 写入原始 JSONL，不经过 pending 跟踪（用于 extension_ui_response 等消息） */
  sendRaw(payload: Record<string, unknown>) {
    if (this.closed) return;
    this.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  close(error?: Error) {
    if (this.closed) return;
    this.closed = true;
    // 关闭后不再解析 stdout，释放可能很大的未完成行。
    this.partialLine = [];
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error ?? new Error(`RPC client closed before response: ${id}`));
    }
    this.pending.clear();
  }

  private write(payload: Record<string, unknown>) {
    if (this.closed) return;
    // 记录发出的 RPC 命令，方便调试
    this.emit("log", { direction: "send", data: payload });
    // pi RPC 使用严格 JSONL 协议；每条命令必须以 LF 结尾，不能依赖 readline 之类的宽松分行。
    this.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  private consumeChunk(chunk: Buffer | string) {
    if (this.closed) return;
    // StringDecoder 保留跨 chunk 的半个多字节字符，这里拿到的文本始终是完整字符。
    this.drainLines(typeof chunk === "string" ? chunk : this.decoder.write(chunk));
  }

  private consumeEnd() {
    if (this.closed) return;
    const rest = this.decoder.end();
    if (rest) this.partialLine.push(rest);
    if (this.partialLine.length > 0) {
      const line = this.partialLine.join("");
      this.partialLine = [];
      this.handleLine(line.endsWith("\r") ? line.slice(0, -1) : line);
    }
  }

  /** 只扫描新文本；未完成的尾部片段留到下次换行时再拼接。 */
  private drainLines(text: string) {
    let start = 0;
    while (!this.closed) {
      const newlineIndex = text.indexOf("\n", start);
      if (newlineIndex === -1) break;
      let line = text.slice(start, newlineIndex);
      if (this.partialLine.length > 0) {
        this.partialLine.push(line);
        line = this.partialLine.join("");
        this.partialLine = [];
      }
      start = newlineIndex + 1;
      if (line.endsWith("\r")) line = line.slice(0, -1);
      this.handleLine(line);
    }
    if (!this.closed && start < text.length) this.partialLine.push(text.slice(start));
  }

  private handleLine(line: string) {
    if (this.closed) return;
    if (!line.trim()) return;

    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      // stdout 被非 JSON 内容污染时保留原文，方便用户排查 PATH、pi 版本或启动脚本问题。
      this.emit("protocol-error", line);
      return;
    }

    // 记录收到的 RPC 消息，方便调试
    this.emit("log", { direction: "recv", data: message });

    if (this.isResponse(message) && message.id && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id)!;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      pending.resolve(message);
      return;
    }

    this.emit("event", message);
  }

  private isResponse(value: unknown): value is RpcResponse {
    return Boolean(value && typeof value === "object" && (value as { type?: unknown }).type === "response");
  }
}
