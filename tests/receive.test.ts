import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ReceiveController,
  isMobileDevice,
  type ReceiveView,
  type SavePicker,
} from "../src/client/receive";
import { MEMORY_LIMIT, type Sink } from "../src/client/transfer";
function harness({
  mobile = false,
  picker,
  size = 20,
}: { mobile?: boolean; picker?: SavePicker; size?: number } = {}) {
  let view: ReceiveView;
  const accepted: { sink?: Sink }[] = [];
  const controller = new ReceiveController(
    { name: "sample.txt", size },
    mobile,
    picker,
    {
      render: (value) => {
        view = value;
      },
      accept: (result) => accepted.push(result),
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
test("phone small files download even if a non-working native picker is exposed", async () => {
  let invoked = 0;
  const h = harness({
    mobile: true,
    picker: async () => {
      invoked++;
      throw new Error("Unavailable");
    },
  });
  assert.equal(h.view.label, "接收并下载");
  assert.equal(h.view.disabled, false);
  await h.controller.accept();
  assert.equal(invoked, 0);
  assert.deepEqual(h.accepted, [{}]);
});
test("desktop native picker is called in the same click stack and creates a streaming sink", async () => {
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
  const result = h.controller.accept();
  assert.equal(called, true);
  assert.equal(h.view.disabled, true);
  await result;
  assert.equal(h.accepted[0].sink, sink);
});
test("picker error becomes an inline message and an enabled download action", async () => {
  const h = harness({
    picker: async () => {
      throw new DOMException("Not supported", "SecurityError");
    },
  });
  await h.controller.accept();
  assert.equal(h.view.error, true);
  assert.equal(h.view.disabled, false);
  assert.equal(h.view.label, "接收并下载");
  assert.match(h.view.hint, /已切换/);
  await h.controller.accept();
  assert.deepEqual(h.accepted, [{}]);
});
test("download fallback stays usable when native picker never settles", async () => {
  const h = harness({ picker: () => new Promise(() => {}) });
  void h.controller.accept();
  assert.equal(h.view.disabled, true);
  assert.equal(h.view.fallback, true);
  h.controller.download();
  assert.deepEqual(h.accepted, [{}]);
});
test("late writable is aborted after switching to download", async () => {
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
  const pending = h.controller.accept();
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
test("closing receive modal invalidates an outstanding picker result", async () => {
  let release!: (value: { createWritable(): Promise<Sink> }) => void;
  let created = false;
  const h = harness({
    picker: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  });
  const pending = h.controller.accept();
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
test("cancelled picker can retry without silently accepting a file", async () => {
  const h = harness({
    picker: async () => {
      throw new DOMException("cancelled", "AbortError");
    },
  });
  await h.controller.accept();
  assert.equal(h.view.disabled, false);
  assert.equal(h.view.error, false);
  assert.equal(h.view.fallback, true);
  assert.equal(h.accepted.length, 0);
});
test("large Android files retain streaming support; memory fallback remains capped", async () => {
  const h = harness({
    mobile: true,
    size: MEMORY_LIMIT + 1,
    picker: async () => ({
      async createWritable() {
        return sink;
      },
    }),
  });
  assert.equal(h.view.label, "选择位置并接收");
  assert.equal(h.view.fallback, false);
  h.controller.download();
  assert.equal(h.accepted.length, 0);
  await h.controller.accept();
  assert.equal(h.accepted[0].sink, sink);
  const limited = harness({ mobile: true, size: MEMORY_LIMIT + 1 });
  assert.equal(limited.view.disabled, true);
  assert.match(limited.view.hint, /128 MiB/);
});
test("large-file write permission failures remain visible and retryable", async () => {
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
  assert.equal(h.accepted.length, 0);
});
test("mobile detection handles Android, iPad desktop UA, and UA client hints", () => {
  assert.equal(
    isMobileDevice({ userAgent: "Android Chrome", maxTouchPoints: 5 }),
    true,
  );
  assert.equal(
    isMobileDevice({ userAgent: "Macintosh Safari", maxTouchPoints: 5 }),
    true,
  );
  assert.equal(
    isMobileDevice({
      userAgent: "Linux",
      maxTouchPoints: 1,
      userAgentData: { mobile: true },
    }),
    true,
  );
  assert.equal(
    isMobileDevice({ userAgent: "Windows Chrome", maxTouchPoints: 5 }),
    false,
  );
});
