import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Miniflare } from "miniflare";
import { createRuntime, createRoom, connect, next } from "./runtime";
let mf: Miniflare;
before(async () => {
  mf = await createRuntime();
});
after(async () => {
  await mf?.dispose();
});
test("security headers and protocol version are explicit", async () => {
  const response = await mf.dispatchFetch("https://near.test/");
  assert.match(
    response.headers.get("Content-Security-Policy")!,
    /frame-ancestors 'none'/,
  );
  const health = await mf.dispatchFetch("https://near.test/api/health");
  assert.equal(health.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await health.json(), { ok: true, protocol: 2 });
});
test("server allocates six-digit rooms and rejects foreign origin or malformed code", async () => {
  assert.match(await createRoom(mf), /^[1-9]\d{5}$/);
  assert.equal(
    (
      await mf.dispatchFetch("https://near.test/api/rooms", {
        method: "POST",
        headers: { Origin: "https://evil.test" },
      })
    ).status,
    403,
  );
  assert.equal((await connect(mf, "bad")).status, 400);
  assert.equal(
    (
      await mf.dispatchFetch("https://near.test/api/room/123456", {
        headers: { Origin: "https://near.test" },
      })
    ).status,
    426,
  );
});
test("unknown rooms return a readable error instead of auto-creating a typo room", async () => {
  const response = await connect(mf, "000000");
  const ws = response.webSocket!;
  const error = next(ws);
  ws.accept();
  assert.match(String((await error).message), /不存在或已过期/);
});
test("numeric room reservation is atomic and cannot overwrite an occupied code", async () => {
  const ns = await mf.getDurableObjectNamespace("ROOMS");
  const stub = ns.get(ns.idFromName("777777"));
  const results = await Promise.all([
    stub.fetch("https://internal/reserve", { method: "POST" }),
    stub.fetch("https://internal/reserve", { method: "POST" }),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
});
test("two devices share a negotiation session and a third gets a readable full-room error", async () => {
  const room = await createRoom(mf);
  const one = await connect(mf, room);
  const a = one.webSocket!;
  const welcomeA = next(a);
  a.accept();
  assert.equal((await welcomeA).type, "welcome");
  const pairedA = next(a);
  const two = await connect(mf, room);
  const b = two.webSocket!;
  const welcomeB = next(b);
  b.accept();
  await welcomeB;
  const pair = await pairedA;
  assert.equal(pair.negotiate, true);
  assert.equal(typeof pair.session, "string");
  const third = await connect(mf, room);
  const c = third.webSocket!;
  const full = next(c);
  c.accept();
  assert.match(String((await full).message), /已有两台/);
  const signal = {
    type: "signal",
    session: pair.session,
    data: { kind: "restart" },
  };
  const received = next(a);
  b.send(JSON.stringify(signal));
  assert.deepEqual(await received, signal);
  a.close(1000);
  b.close(1000);
});
test("a replacement session filters stale SDP and preserves two-device capacity", async () => {
  const room = await createRoom(mf),
    id = crypto.randomUUID();
  const one = await connect(mf, room, id);
  const a = one.webSocket!;
  const wa = next(a);
  a.accept();
  await wa;
  const paired = next(a);
  const two = await connect(mf, room);
  const b = two.webSocket!;
  const wb = next(b);
  b.accept();
  await wb;
  const oldB = next(b);
  const old = await paired;
  await oldB;
  const updated = next(b);
  const replacement = await connect(mf, room, id);
  const r = replacement.webSocket!;
  r.accept();
  const current = await updated;
  assert.notEqual(current.session, old.session);
  const received = next(b);
  r.send(JSON.stringify({ type: "status", session: old.session, open: false }));
  r.send(
    JSON.stringify({
      type: "signal",
      session: old.session,
      data: { kind: "description", type: "offer", sdp: "STALE" },
    }),
  );
  r.send(
    JSON.stringify({
      type: "signal",
      session: current.session,
      data: { kind: "description", type: "offer", sdp: "CURRENT" },
    }),
  );
  assert.equal(((await received).data as { sdp: string }).sdp, "CURRENT");
  b.close(1000);
  r.close(1000);
});
test("ready status is persisted so signaling reconnect does not rebuild a healthy direct channel", async () => {
  const room = await createRoom(mf),
    id = crypto.randomUUID();
  const one = await connect(mf, room);
  const a = one.webSocket!;
  const wa = next(a);
  a.accept();
  await wa;
  const paired = next(a);
  const two = await connect(mf, room, id);
  const b = two.webSocket!;
  b.accept();
  const pair = await paired;
  const status = JSON.stringify({
    type: "status",
    session: pair.session,
    open: true,
  });
  a.send(status);
  b.send(status);
  const checkedA = next(a),
    checkedB = next(b);
  const signal = JSON.stringify({
    type: "signal",
    session: pair.session,
    data: { kind: "restart" },
  });
  a.send(signal);
  b.send(signal);
  await Promise.all([checkedA, checkedB]);
  const updated = next(a);
  const replacement = await connect(mf, room, id, true);
  const c = replacement.webSocket!;
  c.accept();
  assert.equal((await updated).negotiate, false);
  a.close(1000);
  c.close(1000);
});
test("binary file data is forbidden in signaling", async () => {
  const response = await connect(mf, await createRoom(mf));
  const ws = response.webSocket!;
  ws.accept();
  const closed = new Promise<number>((resolve) =>
    ws.addEventListener("close", (e) => resolve(e.code), { once: true }),
  );
  ws.send(new ArrayBuffer(5));
  assert.equal(await closed, 1009);
});
test("short-code creation attempts are rate-limited per IP", async () => {
  for (let i = 0; i < 20; i++) await createRoom(mf, "quota-test");
  const response = await mf.dispatchFetch("https://near.test/api/rooms", {
    method: "POST",
    headers: { Origin: "https://near.test", "CF-Connecting-IP": "quota-test" },
  });
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("Retry-After"), "60");
});
