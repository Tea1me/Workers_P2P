import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BLOCK_SIZE,
  WINDOW_BYTES,
  TransferEngine,
  type Metadata,
  type Progress,
  type Sink,
  type Transport,
} from "../src/client/transfer";
function file(size = BLOCK_SIZE * 2 + 123): File {
  const data = new Uint8Array(size);
  for (let i = 0; i < size; i++) data[i] = i % 251;
  return new File([data], "测试文件.bin", { lastModified: 42 });
}
function harness(
  options: {
    accept?: boolean;
    sink?: Sink;
    intercept?: (
      from: "a" | "b",
      data: string | ArrayBuffer,
      cut: () => void,
    ) => string | ArrayBuffer | null;
  } = {},
) {
  let online = true;
  const progresses: Progress[] = [],
    errors: string[] = [],
    downloads: Blob[] = [];
  let offers = 0;
  let a: TransferEngine, b: TransferEngine;
  const cut = () => {
    online = false;
    a.disconnected();
    b.disconnected();
  };
  const transport = (from: "a" | "b"): Transport => ({
    get open() {
      return online;
    },
    async drain() {
      if (!online) throw new Error("offline");
    },
    send(data) {
      if (!online) throw new Error("offline");
      const result = options.intercept
        ? options.intercept(from, data, cut)
        : data;
      if (result !== null && online)
        queueMicrotask(() => {
          void (from === "a" ? b : a).receive(result);
        });
    },
  });
  const events = {
    offer: async (_meta: Metadata) => {
      offers++;
      return options.accept === false ? null : { sink: options.sink };
    },
    progress: (p: Progress) => {
      progresses.push(p);
    },
    download: (_m: Metadata, blob: Blob) => {
      downloads.push(blob);
    },
    error: (m: string) => {
      errors.push(m);
    },
  };
  a = new TransferEngine(transport("a"), events);
  b = new TransferEngine(transport("b"), events);
  return {
    a,
    b,
    progresses,
    errors,
    downloads,
    cut,
    reconnect: () => {
      online = true;
    },
    get offers() {
      return offers;
    },
  };
}
test("multi-block binary transfer is byte-identical and explicitly acknowledged", async () => {
  const h = harness(),
    original = file();
  assert.equal(await h.a.send(original), "completed");
  assert.equal(h.downloads.length, 1);
  assert.deepEqual(
    await h.downloads[0].arrayBuffer(),
    await original.arrayBuffer(),
  );
  assert.equal(h.a.busy, false);
  assert.equal(h.b.busy, false);
  assert.deepEqual(h.errors, []);
});
test("empty files complete and are downloadable", async () => {
  const h = harness();
  assert.equal(await h.a.send(file(0)), "completed");
  assert.equal(h.downloads[0].size, 0);
});
test("receiver rejection stops transfer without sending any binary", async () => {
  let binary = 0;
  const h = harness({
    accept: false,
    intercept: (_from, data) => {
      if (typeof data !== "string") binary++;
      return data;
    },
  });
  assert.equal(await h.a.send(file()), "rejected");
  assert.equal(binary, 0);
  assert.equal(h.a.busy, false);
});
test("corruption is detected before acknowledgement or download", async () => {
  let corrupted = false;
  const h = harness({
    intercept: (from, data) => {
      if (from === "a" && typeof data !== "string" && !corrupted) {
        corrupted = true;
        const copy = data.slice(0);
        new Uint8Array(copy)[0] ^= 255;
        return copy;
      }
      return data;
    },
  });
  assert.equal(await h.a.send(file()), "rejected");
  assert.equal(h.downloads.length, 0);
  assert.match(h.errors[0], /SHA-256/);
});
test("disconnect after verified write but before ACK resumes at receiver offset", async () => {
  let cutOnce = false,
    firstReadyOffset = -1;
  const h = harness({
    intercept: (from, data, cut) => {
      if (from === "b" && typeof data === "string") {
        const m = JSON.parse(data);
        if (m.type === "ack" && !cutOnce) {
          cutOnce = true;
          cut();
          return null;
        }
        if (m.type === "ready" && cutOnce) firstReadyOffset = m.offset;
      }
      return data;
    },
  });
  const original = file();
  assert.equal(await h.a.send(original), "paused");
  h.reconnect();
  assert.equal(await h.a.resume(), "completed");
  assert.equal(firstReadyOffset, BLOCK_SIZE);
  assert.equal(h.offers, 1);
  assert.deepEqual(
    await h.downloads[0].arrayBuffer(),
    await original.arrayBuffer(),
  );
});
test("disconnect in the middle of an unverified block retransmits that block", async () => {
  let cutOnce = false,
    chunks = 0;
  const h = harness({
    intercept: (from, data, cut) => {
      if (
        from === "a" &&
        typeof data !== "string" &&
        !cutOnce &&
        ++chunks === 3
      ) {
        cutOnce = true;
        cut();
        return null;
      }
      return data;
    },
  });
  const original = file();
  assert.equal(await h.a.send(original), "paused");
  h.reconnect();
  assert.equal(await h.a.resume(), "completed");
  assert.deepEqual(
    await h.downloads[0].arrayBuffer(),
    await original.arrayBuffer(),
  );
});
test("lost final ACK retries without duplicate file or receive prompt", async () => {
  let cutOnce = false;
  const h = harness({
    intercept: (from, data, cut) => {
      if (
        from === "b" &&
        typeof data === "string" &&
        JSON.parse(data).type === "complete" &&
        !cutOnce
      ) {
        cutOnce = true;
        cut();
        return null;
      }
      return data;
    },
  });
  assert.equal(await h.a.send(file()), "paused");
  h.reconnect();
  assert.equal(await h.a.resume(), "completed");
  assert.equal(h.downloads.length, 1);
  assert.equal(h.offers, 1);
});
test("streaming sink receives bounded blocks and closes only after complete verification", async () => {
  const sizes: number[] = [];
  let closed = false;
  const h = harness({
    sink: {
      async write(data) {
        sizes.push(data.byteLength);
      },
      async close() {
        closed = true;
      },
      async abort() {},
    },
  });
  assert.equal(await h.a.send(file()), "completed");
  assert.deepEqual(sizes, [BLOCK_SIZE, BLOCK_SIZE, 123]);
  assert.equal(closed, true);
  assert.equal(h.downloads.length, 0);
});
test("write failure aborts sink and rejects sender", async () => {
  let aborted = false;
  const h = harness({
    sink: {
      async write() {
        throw new Error("磁盘已满");
      },
      async close() {
        assert.fail("must not close");
      },
      async abort() {
        aborted = true;
      },
    },
  });
  assert.equal(await h.a.send(file()), "rejected");
  assert.equal(aborted, true);
  assert.equal(h.downloads.length, 0);
});
test("cancel paused transfer clears both sessions", async () => {
  const h = harness({
    intercept: (from, data, cut) => {
      if (
        from === "b" &&
        typeof data === "string" &&
        JSON.parse(data).type === "ack"
      ) {
        cut();
        return null;
      }
      return data;
    },
  });
  assert.equal(await h.a.send(file()), "paused");
  h.reconnect();
  await h.a.cancel();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(h.a.busy, false);
  assert.equal(h.b.busy, false);
});

test("memory-only receivers reject oversized files before allocating their content", async () => {
  const h = harness();
  await h.b.receive(
    JSON.stringify({
      type: "offer",
      meta: {
        id: crypto.randomUUID(),
        name: "large.bin",
        size: 128 * 1024 * 1024 + 1,
        mime: "",
        modified: 0,
      },
    }),
  );
  assert.equal(h.b.busy, false);
  assert.equal(h.downloads.length, 0);
  assert.match(h.progresses.at(-1)!.detail!, /本地文件存储不可用/);
});
test("simultaneous sends reject cleanly instead of deadlocking", async () => {
  const h = harness();
  assert.deepEqual(
    await Promise.all([h.a.send(file(10)), h.b.send(file(10))]),
    ["rejected", "rejected"],
  );
  assert.equal(h.a.busy, false);
  assert.equal(h.b.busy, false);
  assert.equal(h.downloads.length, 0);
});
test("unsolicited burst input is bounded and does not leave the receiver busy", async () => {
  const h = harness();
  await Promise.all(
    Array.from({ length: 240 }, () => h.b.receive(new ArrayBuffer(64 * 1024))),
  );
  assert.equal(h.b.busy, false);
  assert.equal(h.downloads.length, 0);
  assert.ok(h.errors.some((error) => /过快/.test(error)));
});

test("a slow acknowledgement does not stop subsequent blocks; the window remains bounded", async () => {
  const held: string[] = [];
  let blocks = 0;
  let hold = true;
  const h = harness({
    intercept(from, data) {
      if (typeof data === "string") {
        const m = JSON.parse(data);
        if (from === "a" && m.type === "block") blocks++;
        if (from === "b" && m.type === "ack" && hold) {
          held.push(data);
          return null;
        }
      }
      return data;
    },
  });
  const pending = h.a.send(file(WINDOW_BYTES + BLOCK_SIZE));
  const deadline = Date.now() + 10000;
  while (held.length < WINDOW_BYTES / BLOCK_SIZE) {
    if (Date.now() > deadline) assert.fail("window did not fill");
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(blocks, WINDOW_BYTES / BLOCK_SIZE);
  hold = false;
  for (const ack of held) await h.a.receive(ack);
  assert.equal(await pending, "completed");
  assert.equal(blocks, WINDOW_BYTES / BLOCK_SIZE + 1);
  assert.deepEqual(h.errors, []);
});
test("old receivers without a window advertisement still use one-block flow control", async () => {
  const held: string[] = [];
  let blocks = 0;
  let hold = true;
  const h = harness({
    intercept(from, data) {
      if (typeof data === "string") {
        const m = JSON.parse(data);
        if (from === "b" && m.type === "ready") {
          delete m.window;
          return JSON.stringify(m);
        }
        if (from === "a" && m.type === "block") blocks++;
        if (from === "b" && m.type === "ack" && hold) {
          held.push(data);
          return null;
        }
      }
      return data;
    },
  });
  const pending = h.a.send(file(BLOCK_SIZE * 2));
  while (!held.length) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(blocks, 1);
  hold = false;
  await h.a.receive(held[0]);
  assert.equal(await pending, "completed");
});
test("disk-backed completed files retain a release function and do not build an in-memory blob", async () => {
  let released = false;
  let output: Blob | undefined;
  let cleanup: (() => Promise<void>) | undefined;
  const source = file(0);
  const transport: Transport = { open: true, send() {}, async drain() {} };
  const receiver = new TransferEngine(transport, {
    offer: async () => ({
      sink: {
        async write() {},
        async close() {},
        async abort() {},
        async getFile() {
          return source;
        },
        async release() {
          released = true;
        },
      },
    }),
    progress() {},
    error(message) {
      assert.fail(message);
    },
    download(_meta, blob, release) {
      output = blob;
      cleanup = release;
    },
  });
  const id = crypto.randomUUID();
  await receiver.receive(
    JSON.stringify({
      type: "offer",
      meta: { id, name: "empty.bin", size: 0, mime: "", modified: 0 },
    }),
  );
  await receiver.receive(JSON.stringify({ type: "finish", id }));
  assert.equal(output, source);
  assert.ok(cleanup);
  await cleanup();
  assert.equal(released, true);
});
