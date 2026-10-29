import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Connection } from "../src/client/connection";

class FakeChannel {
  readyState = "connecting";
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  onopen?: () => void;
  onclose?: () => void;
  open() {
    this.readyState = "open";
    this.onopen?.();
  }
  close() {
    this.readyState = "closed";
    this.onclose?.();
  }
}
class FakePeer {
  static instances: FakePeer[] = [];
  localDescription?: { type: string; sdp: string };
  remoteDescription?: { type: string; sdp: string };
  connectionState = "new";
  onconnectionstatechange?: () => void;
  restarts = 0;
  restartIce() {
    this.restarts++;
  }
  channel?: FakeChannel;
  added: unknown[] = [];
  constructor(readonly config: unknown) {
    FakePeer.instances.push(this);
  }
  createDataChannel() {
    return (this.channel = new FakeChannel());
  }
  async createOffer() {
    return { type: "offer", sdp: "v=0 offer" };
  }
  async createAnswer() {
    return { type: "answer", sdp: "v=0 answer" };
  }
  async setLocalDescription(value: { type: string; sdp: string }) {
    this.localDescription = value;
  }
  async setRemoteDescription(value: { type: string; sdp: string }) {
    this.remoteDescription = value;
  }
  async addIceCandidate(value: unknown) {
    this.added.push(value);
  }
  async getStats() {
    return new Map();
  }
  close() {
    this.connectionState = "closed";
  }
}
class FakeSocket {
  static OPEN = 1;
  static instances: FakeSocket[] = [];
  readyState = 1;
  sent: { type: string; session?: string; data?: Record<string, unknown> }[] =
    [];
  onopen?: () => void;
  onmessage?: (event: { data: string }) => void;
  onclose?: (event: { code: number }) => void;
  constructor(readonly url: URL) {
    FakeSocket.instances.push(this);
  }
  send(message: string) {
    if (message !== "ping") this.sent.push(JSON.parse(message));
  }
  emit(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
  close() {
    this.readyState = 3;
    this.onclose?.({ code: 1000 });
  }
}
const originals = new Map<string, PropertyDescriptor | undefined>();
const active: Connection[] = [];
before(() => {
  for (const [key, value] of Object.entries({
    WebSocket: FakeSocket,
    RTCPeerConnection: FakePeer,
    location: { href: "https://near.test/", protocol: "https:" },
  })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      value,
      configurable: true,
      writable: true,
    });
  }
});
afterEach(() => {
  for (const c of active.splice(0)) c.leave();
});
after(() => {
  for (const [key, value] of originals) {
    if (value) Object.defineProperty(globalThis, key, value);
    else Reflect.deleteProperty(globalThis, key);
  }
});
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
function harness() {
  FakePeer.instances.length = 0;
  let lost = 0;
  const connection = new Connection({
    state() {},
    peer() {},
    message() {},
    ready() {},
    lost() {
      lost++;
    },
    route() {},
  });
  active.push(connection);
  connection.join("123456", "test");
  const ws = FakeSocket.instances.at(-1)!;
  ws.onopen?.();
  const id = ws.url.searchParams.get("id");
  return {
    connection,
    ws,
    get lost() {
      return lost;
    },
    pair(
      negotiate = true,
      initiator = true,
      session = "11111111-1111-4111-8111-111111111111",
    ) {
      ws.emit({
        type: "paired",
        negotiate,
        session,
        initiator: initiator ? id : "other",
        peer: { id: "other", name: "Phone" },
      });
    },
    signal(data: unknown, session = "11111111-1111-4111-8111-111111111111") {
      ws.emit({ type: "signal", session, data });
    },
  };
}
test("pair negotiates immediately without a state exchange and includes a STUN route", async () => {
  const h = harness();
  h.pair();
  await settle();
  assert.ok(h.ws.sent.some((m) => m.data?.type === "offer"));
  assert.deepEqual(FakePeer.instances[0].config, {
    iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }],
    iceCandidatePoolSize: 0,
  });
});
test("answering side buffers early ICE until SDP is installed", async () => {
  const h = harness();
  h.pair(true, false);
  await settle();
  h.signal({ kind: "candidate", candidate: { candidate: "candidate:1" } });
  h.signal({ kind: "description", type: "offer", sdp: "v=0 offer" });
  await settle();
  assert.equal(FakePeer.instances[0].added.length, 1);
  assert.ok(h.ws.sent.some((m) => m.data?.type === "answer"));
});
test("stale candidates and offers cannot corrupt a replacement session", async () => {
  const h = harness();
  h.pair();
  await settle();
  const session = "22222222-2222-4222-8222-222222222222";
  h.pair(true, true, session);
  await settle();
  h.signal({ kind: "description", type: "offer", sdp: "STALE" });
  h.signal({ kind: "candidate", candidate: { candidate: "STALE" } });
  await settle();
  const current = FakePeer.instances.at(-1)!;
  assert.equal(current.remoteDescription, undefined);
  assert.equal(current.added.length, 0);
  h.signal({ kind: "description", type: "answer", sdp: "CURRENT" }, session);
  await settle();
  assert.equal(
    (current.remoteDescription as { sdp: string } | undefined)?.sdp,
    "CURRENT",
  );
});
test("healthy direct channel survives signaling reconnect when server confirms both are ready", async () => {
  const h = harness();
  h.pair();
  await settle();
  FakePeer.instances[0].channel!.open();
  h.pair(false, true, "22222222-2222-4222-8222-222222222222");
  await settle();
  assert.equal(h.connection.open, true);
  assert.equal(FakePeer.instances.length, 1);
  assert.equal(h.lost, 0);
});
test("failed ICE gets one automatic restart and no retry loop", async () => {
  const h = harness();
  h.pair();
  await settle();
  const pc = FakePeer.instances[0];
  pc.connectionState = "failed";
  pc.onconnectionstatechange?.();
  await settle();
  assert.equal(pc.restarts, 1);
  pc.onconnectionstatechange?.();
  await settle();
  assert.equal(pc.restarts, 1);
  assert.equal(pc.connectionState, "closed");
});
