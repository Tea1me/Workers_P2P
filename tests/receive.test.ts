import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ReceiveController,
  type ReceiveView,
  type SavePicker,
} from "../src/client/receive";
import { MEMORY_LIMIT, type Sink } from "../src/client/transfer";
function harness({
  picker,
  size = 20,
}: { picker?: SavePicker; size?: number } = {}) {
  let view: ReceiveView;
  const accepted: { sink?: Sink }[] = [];
  const controller = new ReceiveController(
    { name: "sample.txt", size },
    picker,
    {
      render(value) {
        view = value;
      },
      accept(result) {
        accepted.push(result);
      },
    },
  );
  return {
    controller,
    accepted,
    get view() {
      return view;
    },
  };
}
const sink: Sink = { async write() {}, async close() {}, async abort() {} };
test("receive defaults to ordinary download on every device, even with a broken picker", async () => {
  let calls = 0;
  const h = harness({
    picker: async () => {
      calls++;
      throw new Error("Unavailable");
    },
  });
  assert.equal(h.view.label, "接收文件");
  assert.equal(h.view.disabled, false);
  await h.controller.accept();
  assert.equal(calls, 0);
  assert.deepEqual(h.accepted, [{}]);
});
test("disk saving is optional and preserves same-click user activation", async () => {
  let called = false;
  const h = harness({
    picker: async () => {
      called = true;
      return {
        async createWritable() {
          return sink;
        },
      };
    },
  });
  assert.match(h.view.alternateLabel, /可选/);
  const pending = h.controller.alternate();
  assert.equal(called, true);
  await pending;
  assert.equal(h.accepted[0].sink, sink);
});
test("picker error is inline and leaves the ordinary receive button enabled", async () => {
  const h = harness({
    picker: async () => {
      throw new DOMException("denied", "SecurityError");
    },
  });
  await h.controller.alternate();
  assert.equal(h.view.error, true);
  assert.equal(h.view.label, "接收文件");
  assert.equal(h.view.disabled, false);
  await h.controller.accept();
  assert.deepEqual(h.accepted, [{}]);
});
test("pending optional picker cannot trap ordinary reception", async () => {
  const h = harness({ picker: () => new Promise(() => {}) });
  void h.controller.alternate();
  assert.equal(h.view.disabled, true);
  assert.match(h.view.alternateLabel, /普通下载/);
  await h.controller.alternate();
  assert.deepEqual(h.accepted, [{}]);
});
test("late writable is aborted after falling back to ordinary receive", async () => {
  let release!: (value: Sink) => void;
  let aborted = false;
  const h = harness({
    picker: async () => ({
      createWritable: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    }),
  });
  const pending = h.controller.alternate();
  await Promise.resolve();
  h.controller.download();
  release({
    ...sink,
    async abort() {
      aborted = true;
    },
  });
  await pending;
  assert.equal(aborted, true);
  assert.deepEqual(h.accepted, [{}]);
});
test("closing modal invalidates an outstanding picker", async () => {
  let release!: (value: { createWritable(): Promise<Sink> }) => void;
  let created = false;
  const h = harness({
    picker: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  });
  const pending = h.controller.alternate();
  h.controller.close();
  release({
    async createWritable() {
      created = true;
      return sink;
    },
  });
  await pending;
  assert.equal(created, false);
  assert.equal(h.accepted.length, 0);
});
test("cancelling optional native picker leaves download available", async () => {
  const h = harness({
    picker: async () => {
      throw new DOMException("cancel", "AbortError");
    },
  });
  await h.controller.alternate();
  assert.equal(h.view.disabled, false);
  assert.equal(h.accepted.length, 0);
  h.controller.download();
  assert.equal(h.accepted.length, 1);
});
test("large file label is still receive, with supported disk streaming and a bounded fallback", async () => {
  const h = harness({
    size: MEMORY_LIMIT + 1,
    picker: async () => ({
      async createWritable() {
        return sink;
      },
    }),
  });
  assert.equal(h.view.label, "接收文件");
  assert.equal(h.view.fallback, false);
  h.controller.download();
  assert.equal(h.accepted.length, 0);
  await h.controller.accept();
  assert.equal(h.accepted[0].sink, sink);
  const unsupported = harness({ size: MEMORY_LIMIT + 1 });
  assert.equal(unsupported.view.disabled, true);
  assert.match(unsupported.view.hint, /128 MiB/);
});
test("large file permission failures remain visible and retryable", async () => {
  const h = harness({
    size: MEMORY_LIMIT + 1,
    picker: async () => ({
      async createWritable() {
        throw new Error("Permission denied");
      },
    }),
  });
  await h.controller.accept();
  assert.equal(h.view.disabled, false);
  assert.equal(h.view.error, true);
  assert.match(h.view.hint, /存储权限/);
});
