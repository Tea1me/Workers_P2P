import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import {
  Miniflare,
  convertV4MiniflareOptions,
  type WebSocket,
} from "miniflare";
let mf: Miniflare;
before(async () => {
  const result = await build({
    entryPoints: ["src/worker.ts"],
    bundle: true,
    format: "esm",
    write: false,
    external: ["cloudflare:workers"],
    target: "es2022",
  });
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: result.outputFiles[0].text,
      compatibilityDate: "2026-10-29",
      durableObjects: { ROOMS: { className: "TransferRoom", useSQLite: true } },
      serviceBindings: {
        ASSETS: async () =>
          new Response("<html>NearDrop</html>", {
            headers: { "Content-Type": "text/html" },
          }),
      },
    }),
  );
});
after(async () => {
  await mf?.dispose();
});
function connect(
  room = crypto.randomUUID().replaceAll("-", "").slice(0, 24),
  id = crypto.randomUUID(),
  origin = "https://near.test",
) {
  return mf.dispatchFetch(
    `https://near.test/api/room/${room}?id=${id}&name=Test`,
    { headers: { Upgrade: "websocket", Origin: origin } },
  );
}
function next(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeEventListener("message", handler);
      reject(new Error("No WebSocket message"));
    }, 3000);
    const handler = (event: { data: unknown }) => {
      clearTimeout(timer);
      ws.removeEventListener("message", handler);
      resolve(JSON.parse(String(event.data)));
    };
    ws.addEventListener("message", handler);
  });
}
test("static responses have security headers; health is uncached", async () => {
  const response = await mf.dispatchFetch("https://near.test/");
  assert.equal(response.status, 200);
  assert.match(
    response.headers.get("Content-Security-Policy")!,
    /frame-ancestors 'none'/,
  );
  const health = await mf.dispatchFetch("https://near.test/api/health");
  assert.equal(health.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await health.json(), { ok: true, protocol: 1 });
});
test("reject foreign origins, malformed keys, non-upgrade requests and unknown APIs", async () => {
  assert.equal(
    (await connect(undefined, undefined, "https://evil.test")).status,
    403,
  );
  assert.equal((await connect("bad")).status, 400);
  assert.equal(
    (
      await mf.dispatchFetch("https://near.test/api/room/123", {
        headers: { Origin: "https://near.test" },
      })
    ).status,
    426,
  );
  assert.equal(
    (await mf.dispatchFetch("https://near.test/api/upload")).status,
    404,
  );
});
test("two devices pair, relay validated signaling, and reject a third device", async () => {
  const room = crypto.randomUUID().replaceAll("-", "").slice(0, 24);
  const one = await connect(room);
  assert.equal(one.status, 101);
  const a = one.webSocket!;
  const welcomeA = next(a);
  a.accept();
  assert.equal((await welcomeA).type, "welcome");
  const pairedA = next(a);
  const two = await connect(room);
  const b = two.webSocket!;
  const welcomeB = next(b);
  b.accept();
  assert.equal((await welcomeB).type, "welcome");
  const pairing = await pairedA;
  assert.equal(pairing.type, "paired");
  assert.equal(pairing.fresh, true);
  assert.equal((await connect(room)).status, 409);
  const signal = { type: "signal", data: { kind: "state", open: false } };
  const received = next(a);
  b.send(JSON.stringify(signal));
  assert.deepEqual(await received, signal);
  a.close(1000);
  b.close(1000);
});
test("same device reconnect replaces stale socket without consuming a third slot", async () => {
  const room = crypto.randomUUID().replaceAll("-", "").slice(0, 24),
    id = crypto.randomUUID();
  const one = await connect(room, id);
  one.webSocket!.accept();
  const two = await connect(room);
  two.webSocket!.accept();
  const replacement = await connect(room, id);
  assert.equal(replacement.status, 101);
  replacement.webSocket!.accept();
  assert.equal((await connect(room)).status, 409);
  two.webSocket!.close(1000);
  replacement.webSocket!.close(1000);
});
test("binary file data on signaling socket is closed", async () => {
  const response = await connect();
  const ws = response.webSocket!;
  ws.accept();
  const closed = new Promise<number>((resolve) =>
    ws.addEventListener("close", (event) => resolve(event.code), {
      once: true,
    }),
  );
  ws.send(new Uint8Array([1, 2, 3]).buffer);
  assert.equal(await closed, 1009);
});

test("retained-channel reconnect does not advertise a fresh negotiation", async () => {
  const room = crypto.randomUUID().replaceAll("-", "").slice(0, 24);
  const first = await connect(room);
  const a = first.webSocket!;
  const welcome = next(a);
  a.accept();
  await welcome;
  const paired = next(a);
  const second = await mf.dispatchFetch(
    `https://near.test/api/room/${room}?id=${crypto.randomUUID()}&resume=1`,
    { headers: { Upgrade: "websocket", Origin: "https://near.test" } },
  );
  const b = second.webSocket!;
  b.accept();
  assert.equal((await paired).fresh, false);
  a.close(1000);
  b.close(1000);
});
