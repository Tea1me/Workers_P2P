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
  sent: { type: string; data: Record<string, unknown> }[] = [];
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
  connection.join("a".repeat(24), "test");
  const ws = FakeSocket.instances.at(-1)!;
  ws.onopen?.();
  const id = ws.url.searchParams.get("id");
  return {
    connection,
    ws,
    get lost() {
      return lost;
    },
    pair(fresh?: boolean, initiator = true) {
      ws.emit({
        type: "paired",
        fresh,
        initiator: initiator ? id : "other",
        peer: { id: "other", name: "Phone" },
      });
    },
    signal(data: unknown) {
      ws.emit({ type: "signal", data });
    },
  };
}
test("fresh pair sends offer without waiting for remote state; later state cannot reset negotiation", async () => {
  const h = harness();
  h.pair(true);
  await settle();
  assert.ok(
    h.ws.sent.some(
      (m) => m.data.kind === "description" && m.data.type === "offer",
    ),
  );
  const original = FakePeer.instances[0];
  h.signal({ kind: "state", open: false });
  await settle();
  assert.equal(FakePeer.instances.length, 1);
  assert.equal(original.connectionState, "new");
});
test("fresh answering side buffers early ICE and answers without a state round trip", async () => {
  const h = harness();
  h.pair(true, false);
  await settle();
  assert.equal(FakePeer.instances.length, 1);
  h.signal({ kind: "candidate", candidate: { candidate: "candidate:1" } });
  h.signal({ kind: "description", type: "offer", sdp: "v=0 offer" });
  await settle();
  assert.equal(FakePeer.instances[0].added.length, 1);
  assert.ok(h.ws.sent.some((m) => m.data.type === "answer"));
});
test("old server without fresh hint retains the compatible state handshake", async () => {
  const h = harness();
  h.pair();
  await settle();
  assert.equal(FakePeer.instances.length, 0);
  h.signal({ kind: "state", open: false });
  await settle();
  assert.equal(FakePeer.instances.length, 1);
  assert.ok(h.ws.sent.some((m) => m.data.type === "offer"));
});
test("healthy direct channel survives a signaling re-pair when both devices are open", async () => {
  const h = harness();
  h.pair(true);
  await settle();
  FakePeer.instances[0].channel!.open();
  h.pair(false);
  h.signal({ kind: "state", open: true });
  await settle();
  assert.equal(h.connection.open, true);
  assert.equal(FakePeer.instances.length, 1);
  assert.equal(h.lost, 0);
});
test("retained channel rebuilds if the other device lost its channel", async () => {
  const h = harness();
  h.pair(true);
  await settle();
  FakePeer.instances[0].channel!.open();
  h.pair(false);
  h.signal({ kind: "state", open: false });
  await settle();
  assert.equal(FakePeer.instances.length, 2);
  assert.equal(h.lost, 1);
});
