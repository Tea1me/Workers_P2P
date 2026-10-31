import {
  TransferEngine,
  type Transport,
  type Metadata,
} from "../../src/client/transfer";
import { ReceiveController } from "../../src/client/receive";
import { createTemporarySink } from "../../src/client/storage";

declare global {
  interface Window {
    regression: {
      run(size: number): Promise<{ size: number; label: string }>;
      cleanup(): Promise<void>;
    };
  }
}
let cleanup: (() => Promise<void>) | undefined;
window.regression = {
  async run(size) {
    const unit = new Uint8Array(1024 * 1024);
    unit.fill(0x5a);
    const source = await createTemporarySink({ id: crypto.randomUUID(), size });
    for (let position = 0; position < size; position += unit.byteLength)
      await source.write(
        unit.slice(0, Math.min(unit.byteLength, size - position)).buffer,
      );
    await source.close();
    const file = new File([await source.getFile!()], "large-receive.bin", {
      lastModified: 1,
    });
    let sender!: TransferEngine, receiver!: TransferEngine;
    let snapshot: Blob | undefined;
    let label = "";
    const failures: string[] = [];
    const transport = (target: () => TransferEngine): Transport => ({
      open: true,
      async drain() {},
      send(data) {
        queueMicrotask(() => {
          void target().receive(data);
        });
      },
    });
    sender = new TransferEngine(
      transport(() => receiver),
      {
        offer: async () => null,
        progress() {},
        download() {},
        error(message) {
          failures.push(message);
        },
      },
    );
    receiver = new TransferEngine(
      transport(() => sender),
      {
        offer: (meta: Metadata) =>
          new Promise((resolve) => {
            const controller = new ReceiveController(
              meta,
              undefined,
              {
                render(view) {
                  label = view.label;
                },
                accept: resolve,
              },
              () => createTemporarySink(meta),
            );
            void controller.accept();
          }),
        progress() {},
        error(message) {
          failures.push(message);
        },
        download(_meta, blob, release) {
          snapshot = blob;
          cleanup = release;
        },
      },
    );
    const status = await sender.send(file);
    await source.release!();
    if (status !== "completed" || !snapshot || failures.length)
      throw new Error(`${status}: ${failures.join(";")}`);
    const link = document.createElement("a");
    link.textContent = "保存文件";
    link.href = URL.createObjectURL(snapshot);
    link.download = file.name;
    document.body.append(link);
    return { size: snapshot.size, label };
  },
  async cleanup() {
    const link = document.querySelector("a");
    if (link) {
      URL.revokeObjectURL(link.href);
      link.remove();
    }
    await cleanup?.();
  },
};
