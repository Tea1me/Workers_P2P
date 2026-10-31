import type { Metadata, Sink } from "./transfer";
const PREFIX = "neardrop-receive";
let session: string | undefined;
let folder: Promise<FileSystemDirectoryHandle> | undefined;

export function hasTemporaryStorage(): boolean {
  return typeof navigator.storage?.getDirectory === "function";
}
async function sessionFolder(): Promise<FileSystemDirectoryHandle> {
  if (!folder)
    folder = (async () => {
      const root = await navigator.storage.getDirectory();
      const base = await root.getDirectoryHandle(PREFIX, { create: true });
      // Clean only our own old sessions. Other open tabs and unrelated origin files are preserved.
      const iterable = base as FileSystemDirectoryHandle &
        AsyncIterable<[string, FileSystemHandle]>;
      for await (const [name] of iterable) {
        const timestamp = Number(name.split("-")[0]);
        if (
          Number.isFinite(timestamp) &&
          timestamp < Date.now() - 7 * 86400000
        ) {
          try {
            await base.removeEntry(name, { recursive: true });
          } catch {
            /* another tab may be using it */
          }
        }
      }
      session ??= `${Date.now()}-${crypto.randomUUID()}`;
      return base.getDirectoryHandle(session, { create: true });
    })().catch((error) => {
      folder = undefined;
      throw error;
    });
  return folder;
}

/** Disk-backed receive spool. A File snapshot can be downloaded without loading the entire file into JS memory. */
export async function createTemporarySink(
  meta: Pick<Metadata, "id" | "size">,
): Promise<Sink> {
  const directory = await sessionFolder();
  const handle = await directory.getFileHandle(meta.id, { create: true });
  let writer: Pick<Sink, "write" | "close" | "abort"> | undefined;
  let closed = false;
  let released = false;
  const release = async () => {
    if (released) return;
    try {
      await directory.removeEntry(meta.id);
      released = true;
    } catch (error) {
      if ((error as Error).name !== "NotFoundError") throw error;
      released = true;
    }
  };
  try {
    if (typeof handle.createWritable === "function") {
      const stream = await handle.createWritable();
      writer = {
        write: (data) => stream.write(data),
        close: () => stream.close(),
        abort: () => stream.abort(),
      };
    } else writer = await workerWriter(handle);
    const sink = writer;
    return {
      write: (data) => sink.write(data),
      async close() {
        await sink.close();
        closed = true;
      },
      async abort() {
        try {
          if (!closed) await sink.abort();
        } finally {
          await release();
        }
      },
      async getFile() {
        if (!closed) throw new Error("文件仍在接收");
        return handle.getFile();
      },
      release,
    };
  } catch (error) {
    try {
      await writer?.abort();
    } finally {
      await release();
    }
    throw error;
  }
}

function workerWriter(
  handle: FileSystemFileHandle,
): Promise<Pick<Sink, "write" | "close" | "abort">> {
  const worker = new Worker(new URL("./storage-worker.ts", import.meta.url), {
    type: "module",
  });
  let sequence = 0;
  const pending = new Map<
    number,
    {
      resolve(): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  function stop(error: Error) {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
    worker.terminate();
  }
  worker.onerror = () =>
    stop(new Error("浏览器无法启动本地文件写入，请更新浏览器或检查存储权限"));
  worker.onmessage = (event) => {
    const { id, error } = event.data as { id: number; error?: string };
    const request = pending.get(id);
    if (!request) return;
    pending.delete(id);
    clearTimeout(request.timer);
    if (error) request.reject(new Error(error));
    else request.resolve();
  };
  function call(type: string, data?: ArrayBuffer): Promise<void> {
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(
        () => stop(new Error("本地文件写入没有响应，请检查可用空间")),
        60000,
      );
      pending.set(id, { resolve, reject, timer });
      try {
        worker.postMessage(
          { type, id, data, handle: type === "init" ? handle : undefined },
          data ? [data] : [],
        );
      } catch (error) {
        clearTimeout(timer);
        pending.delete(id);
        reject(error as Error);
      }
    });
  }
  return call("init")
    .then(() => ({
      write: (data: ArrayBuffer) => call("write", data),
      async close() {
        try {
          await call("close");
        } finally {
          worker.terminate();
        }
      },
      async abort() {
        try {
          await call("abort");
        } finally {
          worker.terminate();
        }
      },
    }))
    .catch((error) => {
      stop(error as Error);
      throw error;
    });
}
