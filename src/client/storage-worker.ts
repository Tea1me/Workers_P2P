// Fallback for browsers exposing OPFS sync access but not createWritable(). Never runs on the UI thread.
interface Access {
  write(data: Uint8Array, options: { at: number }): number | Promise<number>;
  truncate(size: number): void | Promise<void>;
  flush(): void | Promise<void>;
  close(): void | Promise<void>;
}
const context = self as unknown as {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage(message: { id: number; error?: string }): void;
};
let access: Access | undefined;
let position = 0;
let chain = Promise.resolve();
context.onmessage = (event) => {
  const request = event.data as {
    id: number;
    type: string;
    handle?: FileSystemFileHandle & {
      createSyncAccessHandle(): Promise<Access>;
    };
    data?: ArrayBuffer;
  };
  chain = chain.then(async () => {
    try {
      if (request.type === "init") {
        access = await request.handle!.createSyncAccessHandle();
        await access.truncate(0);
      } else if (request.type === "write") {
        if (!access || !request.data) throw new Error("本地文件写入尚未就绪");
        const bytes = new Uint8Array(request.data);
        let offset = 0;
        while (offset < bytes.byteLength) {
          const count = await access.write(bytes.subarray(offset), {
            at: position,
          });
          if (
            !Number.isSafeInteger(count) ||
            count <= 0 ||
            count > bytes.byteLength - offset
          )
            throw new Error("本地文件写入不完整，请检查磁盘空间");
          offset += count;
          position += count;
        }
      } else {
        if (access) {
          if (request.type === "close") await access.flush();
          await access.close();
          access = undefined;
        }
      }
      context.postMessage({ id: request.id });
    } catch (error) {
      context.postMessage({
        id: request.id,
        error: (error as Error).message || "本地存储不可用",
      });
    }
  });
};
export {};
