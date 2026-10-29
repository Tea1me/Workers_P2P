import { isRecord } from "../shared/protocol";
import { safeName } from "./format";
export const BLOCK_SIZE = 1024 * 1024;
export const CHUNK_SIZE = 64 * 1024;
export const MEMORY_LIMIT = 128 * 1024 * 1024;
export interface Metadata {
  id: string;
  name: string;
  size: number;
  mime: string;
  modified: number;
}
export type TransferStatus =
  | "waiting"
  | "sending"
  | "receiving"
  | "paused"
  | "completed"
  | "rejected"
  | "error"
  | "cancelled";
export interface Progress {
  id: string;
  name: string;
  size: number;
  bytes: number;
  direction: "send" | "receive";
  status: TransferStatus;
  detail?: string;
}
export interface Sink {
  write(data: ArrayBuffer): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
}
export interface Transport {
  readonly open: boolean;
  send(data: string | ArrayBuffer): void;
  drain(): Promise<void>;
}
interface Incoming {
  meta: Metadata;
  offset: number;
  sink?: Sink;
  parts: ArrayBuffer[];
  block?: {
    offset: number;
    size: number;
    hash: string;
    buffer: Uint8Array;
    filled: number;
  };
}
interface Outgoing {
  file: File;
  meta: Metadata;
  offset: number;
}
interface Events {
  offer: (meta: Metadata) => Promise<{ sink?: Sink } | null>;
  progress: (p: Progress) => void;
  download: (meta: Metadata, blob: Blob) => void;
  error: (message: string) => void;
}
interface Waiter {
  id: string;
  type: string;
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
}
export function validMetadata(m: unknown): m is Metadata {
  return (
    isRecord(m) &&
    typeof m.id === "string" &&
    /^[a-f0-9-]{36}$/.test(m.id) &&
    typeof m.name === "string" &&
    m.name.length > 0 &&
    m.name.length <= 512 &&
    Number.isSafeInteger(m.size) &&
    Number(m.size) >= 0 &&
    Number(m.size) <= 1024 ** 4 &&
    typeof m.mime === "string" &&
    m.mime.length <= 200 &&
    Number.isSafeInteger(m.modified)
  );
}
export async function digest(buffer: ArrayBuffer): Promise<string> {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", buffer)),
    (n) => n.toString(16).padStart(2, "0"),
  ).join("");
}
/** Ordered, reliable RTC channel + acknowledged 1 MiB blocks. Only verified blocks advance the resume offset. */
export class TransferEngine {
  private incoming?: Incoming;
  private outgoing?: Outgoing;
  private waiter?: Waiter;
  private chain: Promise<void> = Promise.resolve();
  private queuedBytes = 0;
  private queuedMessages = 0;
  private running = false;
  private completed = new Map<string, Metadata>();
  private epoch = 0;
  constructor(
    private transport: Transport,
    private events: Events,
  ) {}
  get busy(): boolean {
    return !!this.incoming || !!this.outgoing;
  }
  get resumable(): boolean {
    return !!this.outgoing && !this.running;
  }
  private control(message: Record<string, unknown>): void {
    this.transport.send(JSON.stringify(message));
  }
  private respond(message: Record<string, unknown>): void {
    // A lost acknowledgement must not discard an already verified / committed block.
    if (this.transport.open) {
      try {
        this.control(message);
      } catch {
        /* retry offer recovers the confirmed offset */
      }
    }
  }
  private report(
    meta: Metadata,
    bytes: number,
    direction: "send" | "receive",
    status: TransferStatus,
    detail?: string,
  ): void {
    this.events.progress({ ...meta, bytes, direction, status, detail });
  }
  private wait(
    id: string,
    type: string,
    send: () => void,
    timeout = 45000,
  ): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.waiter === waiter) this.waiter = undefined;
        reject(
          new Error(
            type === "ready"
              ? "对方未及时确认，可重试发送"
              : "等待接收确认超时，可继续传输",
          ),
        );
      }, timeout);
      const waiter: Waiter = {
        id,
        type,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      };
      this.waiter = waiter;
      try {
        send();
      } catch (error) {
        this.waiter = undefined;
        waiter.reject(error as Error);
      }
    });
  }
  async send(file: File): Promise<TransferStatus> {
    if (this.busy || this.running) throw new Error("请先完成当前传输");
    this.outgoing = {
      file,
      meta: {
        id: crypto.randomUUID(),
        name: file.name.slice(0, 512),
        size: file.size,
        mime: file.type.slice(0, 200),
        modified: file.lastModified,
      },
      offset: 0,
    };
    return this.run();
  }
  async resume(): Promise<TransferStatus> {
    if (!this.outgoing || this.running) throw new Error("没有可继续的文件");
    return this.run();
  }
  private async run(): Promise<TransferStatus> {
    const out = this.outgoing!;
    const { meta, file } = out;
    const epoch = this.epoch;
    this.running = true;
    const current = () => {
      if (this.outgoing !== out || epoch !== this.epoch || !this.transport.open)
        throw new Error("连接已中断，可重新连接后继续");
    };
    this.report(meta, out.offset, "send", "waiting");
    try {
      current();
      const ready = await this.wait(
        meta.id,
        "ready",
        () => this.control({ type: "offer", meta }),
        120000,
      );
      current();
      const offset = Number(ready.offset);
      if (
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        offset > file.size ||
        (offset !== file.size && offset % BLOCK_SIZE !== 0)
      )
        throw new Error("接收端进度无效");
      out.offset = offset;
      this.report(meta, out.offset, "send", "sending");
      while (out.offset < file.size) {
        current();
        const buffer = await file
          .slice(out.offset, out.offset + BLOCK_SIZE)
          .arrayBuffer();
        const hash = await digest(buffer);
        current();
        this.control({
          type: "block",
          id: meta.id,
          offset: out.offset,
          size: buffer.byteLength,
          hash,
        });
        for (let i = 0; i < buffer.byteLength; i += CHUNK_SIZE) {
          await this.transport.drain();
          current();
          this.transport.send(buffer.slice(i, i + CHUNK_SIZE));
        }
        const ack = await this.wait(meta.id, "ack", () =>
          this.control({ type: "commit", id: meta.id }),
        );
        current();
        if (ack.offset !== out.offset + buffer.byteLength)
          throw new Error("接收端确认进度不匹配");
        out.offset = Number(ack.offset);
        this.report(meta, out.offset, "send", "sending");
      }
      await this.wait(meta.id, "complete", () =>
        this.control({ type: "finish", id: meta.id }),
      );
      current();
      this.outgoing = undefined;
      this.report(meta, file.size, "send", "completed");
      return "completed";
    } catch (error) {
      const message = (error as Error).message;
      if (this.outgoing !== out) return "cancelled";
      if (message.startsWith("拒绝：")) {
        this.outgoing = undefined;
        this.report(meta, out.offset, "send", "rejected", message.slice(3));
        return "rejected";
      }
      this.report(meta, out.offset, "send", "paused", message);
      return "paused";
    } finally {
      this.running = false;
    }
  }
  receive(data: string | ArrayBuffer): Promise<void> {
    const size = typeof data === "string" ? data.length * 2 : data.byteLength;
    if (
      this.queuedBytes + size > BLOCK_SIZE * 2 ||
      this.queuedMessages >= 128
    ) {
      this.events.error("对方发送过快或未遵循传输协议，已取消接收");
      this.disconnected();
      void this.cancel();
      return Promise.resolve();
    }
    this.queuedBytes += size;
    ++this.queuedMessages;
    const epoch = this.epoch;
    this.chain = this.chain
      .then(async () => {
        if (epoch !== this.epoch) return;
        if (typeof data === "string") {
          if (data.length > 4096) throw new Error("控制消息过大");
          const message: unknown = JSON.parse(data);
          if (!isRecord(message) || typeof message.type !== "string")
            throw new Error("无效传输消息");
          await this.handle(message);
        } else await this.binary(data);
      })
      .catch(async (error) => {
        this.events.error((error as Error).message);
        if (this.incoming)
          await this.dropIncoming("error", (error as Error).message);
        if (this.waiter) {
          this.waiter.reject(error as Error);
          this.waiter = undefined;
        }
      })
      .finally(() => {
        this.queuedBytes -= size;
        --this.queuedMessages;
      });
    return this.chain;
  }
  private async handle(m: Record<string, unknown>): Promise<void> {
    if (
      this.waiter &&
      m.id === this.waiter.id &&
      (m.type === this.waiter.type || m.type === "reject")
    ) {
      const waiter = this.waiter;
      this.waiter = undefined;
      if (m.type === "reject")
        waiter.reject(new Error(`拒绝：${String(m.reason ?? "对方已取消")}`));
      else waiter.resolve(m);
      return;
    }
    if (m.type === "offer") {
      if (!validMetadata(m.meta)) throw new Error("无效文件信息");
      const meta = { ...m.meta, name: safeName(m.meta.name) };
      const done = this.completed.get(meta.id);
      if (done) {
        if (
          done.name !== meta.name ||
          done.size !== meta.size ||
          done.modified !== meta.modified
        )
          throw new Error("文件会话不匹配");
        this.respond({ type: "ready", id: meta.id, offset: meta.size });
        return;
      }
      if (this.incoming?.meta.id === meta.id) {
        const old = this.incoming;
        if (
          old.meta.size !== meta.size ||
          old.meta.name !== meta.name ||
          old.meta.modified !== meta.modified
        )
          throw new Error("续传文件不匹配");
        old.block = undefined;
        this.respond({ type: "ready", id: meta.id, offset: old.offset });
        this.report(meta, old.offset, "receive", "receiving");
        return;
      }
      if (this.busy) {
        this.respond({
          type: "reject",
          id: meta.id,
          reason: "设备正在传输其他文件",
        });
        return;
      }
      const incoming: Incoming = { meta, offset: 0, parts: [] };
      this.incoming = incoming;
      this.report(meta, 0, "receive", "waiting");
      const decision = await this.events.offer(meta);
      if (this.incoming !== incoming) {
        await decision?.sink?.abort();
        return;
      }
      if (!decision) {
        await this.dropIncoming("rejected", "已拒绝接收");
        return;
      }
      if (!decision.sink && meta.size > MEMORY_LIMIT) {
        await this.dropIncoming(
          "rejected",
          "文件超过浏览器内存模式的 128 MB 上限，请使用桌面 Chrome / Edge 直接保存",
        );
        return;
      }
      incoming.sink = decision.sink;
      this.respond({ type: "ready", id: meta.id, offset: 0 });
      this.report(meta, 0, "receive", "receiving");
      return;
    }
    const incoming = this.incoming;
    if (m.type === "cancel") {
      if (incoming?.meta.id === m.id)
        await this.dropIncoming("cancelled", "对方取消了传输", false);
      if (this.outgoing?.meta.id === m.id)
        this.cancelOutgoing("对方取消了传输");
      return;
    }
    if (!incoming || m.id !== incoming.meta.id) {
      if (
        m.type === "finish" &&
        typeof m.id === "string" &&
        this.completed.has(m.id)
      ) {
        this.respond({ type: "complete", id: m.id });
        return;
      }
      if (
        typeof m.id === "string" &&
        ["block", "commit", "finish"].includes(String(m.type))
      )
        this.respond({
          type: "reject",
          id: m.id,
          reason: "接收记录已丢失，请取消并重新发送",
        });
      if (
        m.type === "offer" ||
        m.type === "block" ||
        m.type === "commit" ||
        m.type === "finish"
      )
        throw new Error("文件会话不存在，请重新发送");
      return;
    }
    if (m.type === "block") {
      if (
        incoming.block ||
        m.offset !== incoming.offset ||
        !Number.isSafeInteger(m.size) ||
        Number(m.size) !==
          Math.min(BLOCK_SIZE, incoming.meta.size - incoming.offset) ||
        Number(m.size) <= 0 ||
        typeof m.hash !== "string" ||
        !/^[a-f0-9]{64}$/.test(m.hash)
      )
        throw new Error("分块信息无效");
      incoming.block = {
        offset: incoming.offset,
        size: Number(m.size),
        hash: m.hash,
        buffer: new Uint8Array(Number(m.size)),
        filled: 0,
      };
    } else if (m.type === "commit") {
      const block = incoming.block;
      if (!block || block.filled !== block.size)
        throw new Error("文件分块不完整");
      if ((await digest(block.buffer.buffer as ArrayBuffer)) !== block.hash)
        throw new Error("SHA-256 校验失败，请重新发送");
      if (incoming.sink)
        await incoming.sink.write(block.buffer.buffer as ArrayBuffer);
      else incoming.parts.push(block.buffer.buffer as ArrayBuffer);
      incoming.offset += block.size;
      incoming.block = undefined;
      this.respond({
        type: "ack",
        id: incoming.meta.id,
        offset: incoming.offset,
      });
      this.report(incoming.meta, incoming.offset, "receive", "receiving");
    } else if (m.type === "finish") {
      if (incoming.block || incoming.offset !== incoming.meta.size)
        throw new Error("文件长度不匹配");
      if (incoming.sink) await incoming.sink.close();
      else
        this.events.download(
          incoming.meta,
          new Blob(incoming.parts, { type: "application/octet-stream" }),
        );
      this.report(incoming.meta, incoming.offset, "receive", "completed");
      this.incoming = undefined;
      this.completed.set(incoming.meta.id, incoming.meta);
      if (this.completed.size > 100)
        this.completed.delete(this.completed.keys().next().value!);
      this.respond({ type: "complete", id: incoming.meta.id });
    } else throw new Error("未知传输指令");
  }
  private binary(data: ArrayBuffer): void {
    const block = this.incoming?.block;
    if (
      !block ||
      data.byteLength === 0 ||
      data.byteLength > CHUNK_SIZE ||
      block.filled + data.byteLength > block.size
    )
      throw new Error("收到超出预期的文件数据");
    block.buffer.set(new Uint8Array(data), block.filled);
    block.filled += data.byteLength;
  }
  disconnected(): void {
    ++this.epoch;
    this.waiter?.reject(new Error("连接已断开，可重新连接后继续"));
    this.waiter = undefined;
    if (this.incoming) {
      this.incoming.block = undefined;
      this.report(
        this.incoming.meta,
        this.incoming.offset,
        "receive",
        "paused",
        "等待发送方重新连接并继续",
      );
    }
  }
  private async dropIncoming(
    status: TransferStatus,
    detail: string,
    notify = true,
  ): Promise<void> {
    const incoming = this.incoming;
    if (!incoming) return;
    this.incoming = undefined;
    if (notify && this.transport.open)
      this.respond({ type: "reject", id: incoming.meta.id, reason: detail });
    try {
      await incoming.sink?.abort();
    } catch {
      /* best-effort cleanup */
    }
    this.report(incoming.meta, incoming.offset, "receive", status, detail);
  }
  private cancelOutgoing(detail: string): void {
    const out = this.outgoing;
    if (!out) return;
    this.outgoing = undefined;
    this.waiter?.reject(new Error(detail));
    this.waiter = undefined;
    this.report(out.meta, out.offset, "send", "cancelled", detail);
  }
  async cancel(): Promise<void> {
    if (this.outgoing) {
      if (this.transport.open)
        this.control({ type: "cancel", id: this.outgoing.meta.id });
      this.cancelOutgoing("已取消");
    }
    if (this.incoming) await this.dropIncoming("cancelled", "已取消接收");
  }
}
