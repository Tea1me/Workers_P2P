import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import wrtc from "@roamhq/wrtc";
const NativePeer = wrtc.RTCPeerConnection;
import type { WebSocket as WorkerWebSocket } from "miniflare";
import { Connection } from "../../src/client/connection";
import { TransferEngine, type Metadata } from "../../src/client/transfer";
import { createRuntime, createRoom } from "./runtime";

// This test uses real libwebrtc ICE + DTLS + SCTP through the production Worker signaling code.
// STUN is disabled only here: loopback testing must not depend on public Internet availability.
test(
  "real WebRTC peers connect, transfer a multi-block file, reconnect from one side, and send back",
  { timeout: 30000 },
  async (t) => {
    const probe = new NativePeer({ iceServers: [] });
    const hostAvailable = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 3000);
      probe.onicecandidate = (event) => {
        if (event.candidate) {
          clearTimeout(timer);
          resolve(true);
        }
      };
      probe.createDataChannel("probe");
      void probe
        .createOffer()
        .then((offer) => probe.setLocalDescription(offer))
        .catch(() => {
          clearTimeout(timer);
          resolve(false);
        });
    });
    probe.close();
    if (!hostAvailable) {
      if (process.env.CI)
        throw new Error("CI runner has no usable host ICE candidates");
      t.skip(
        "Restricted runtime exposes no usable native ICE candidates; this check is mandatory in CI",
      );
      return;
    }
    const mf = await createRuntime();
    const originals = new Map<string, PropertyDescriptor | undefined>();
    let intentionalDisconnect = false;
    let signalCount = 0;
    const trace: unknown[] = [];
    class LocalPeer extends NativePeer {
      constructor(config: RTCConfiguration) {
        super({ ...config, iceServers: [] });
      }
    }
    class WorkerSocket {
      static OPEN = 1;
      readyState = 0;
      raw?: WorkerWebSocket;
      closed = false;
      onopen?: () => void;
      onmessage?: (event: { data: unknown }) => void;
      onclose?: (event: { code: number }) => void;
      onerror?: () => void;
      constructor(url: URL) {
        const endpoint = new URL(url);
        endpoint.protocol = "https:";
        void mf
          .dispatchFetch(endpoint.href, {
            headers: { Origin: "https://near.test", Upgrade: "websocket" },
          })
          .then((response) => {
            const raw = response.webSocket;
            if (!raw) throw new Error(`Upgrade failed: ${response.status}`);
            this.raw = raw;
            raw.addEventListener("message", (e) => {
              const m = JSON.parse(String(e.data));
              trace.push(["in", m.type, m.session, m.data?.kind, m.data?.type]);
              this.onmessage?.({ data: e.data });
            });
            raw.addEventListener("close", (e) => {
              this.readyState = 3;
              this.onclose?.({ code: e.code });
            });
            this.readyState = 1;
            raw.accept();
            if (this.closed) raw.close(1000);
            else this.onopen?.();
          })
          .catch(() => {
            this.readyState = 3;
            this.onerror?.();
            this.onclose?.({ code: 1006 });
          });
      }
      send(data: string) {
        if (data !== "ping") {
          signalCount++;
          const m = JSON.parse(data);
          trace.push(["out", m.type, m.session, m.data?.kind, m.data?.type]);
        }
        this.raw!.send(data);
      }
      close() {
        this.closed = true;
        this.raw?.close(1000);
      }
    }
    function replace(key: string, value: unknown) {
      originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
      Object.defineProperty(globalThis, key, {
        value,
        configurable: true,
        writable: true,
      });
    }
    replace("WebSocket", WorkerSocket);
    replace("RTCPeerConnection", LocalPeer);
    replace("location", { href: "https://near.test/", protocol: "https:" });
    function peer() {
      const downloads: { meta: Metadata; blob: Blob }[] = [];
      const errors: string[] = [];
      let ready = 0;
      const connection = new Connection({
        state(state, detail) {
          trace.push(["state", state, detail]);
          if (state === "failed" && !intentionalDisconnect)
            errors.push(detail ?? "failed");
        },
        peer() {},
        message(data) {
          void engine.receive(data);
        },
        ready() {
          ready++;
        },
        lost() {
          engine.disconnected();
        },
        route() {},
      });
      const engine = new TransferEngine(connection, {
        offer: async () => ({}),
        progress() {},
        download(meta, blob) {
          downloads.push({ meta, blob });
        },
        error: (message) => errors.push(message),
      });
      return {
        connection,
        engine,
        downloads,
        errors,
        get ready() {
          return ready;
        },
      };
    }
    const a = peer(),
      b = peer();
    async function waitFor(predicate: () => boolean) {
      const deadline = Date.now() + 10000;
      while (!predicate()) {
        if (a.errors.length || b.errors.length)
          throw new Error(
            [...a.errors, ...b.errors].join("; ") + JSON.stringify(trace),
          );
        if (Date.now() > deadline)
          throw new Error(
            "Real RTC channel did not open: " + JSON.stringify(trace),
          );
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    try {
      const room = await createRoom(mf);
      a.connection.join(room, "Computer");
      b.connection.join(room, "Phone");
      await waitFor(() => a.connection.open && b.connection.open);
      const payload = new Uint8Array(12 * 1024 * 1024 + 777);
      for (let i = 0; i < payload.length; i++) payload[i] = i % 251;
      const file = new File([payload], "sample.bin", { lastModified: 42 });
      assert.equal(await a.engine.send(file), "completed");
      const originalHash = createHash("sha256").update(payload).digest("hex");
      const receivedHash = createHash("sha256")
        .update(new Uint8Array(await b.downloads[0].blob.arrayBuffer()))
        .digest("hex");
      assert.equal(receivedHash, originalHash);
      // The remote channel is expected to close while one device explicitly reconnects.
      intentionalDisconnect = true;
      a.connection.reconnect();
      await waitFor(
        () =>
          a.ready >= 2 &&
          b.ready >= 2 &&
          a.connection.open &&
          b.connection.open,
      );
      intentionalDisconnect = false;
      assert.equal(
        await b.engine.send(new File(["手机 → 电脑"], "reverse.txt")),
        "completed",
      );
      assert.equal(await a.downloads[0].blob.text(), "手机 → 电脑");
      assert.ok(signalCount > 4);
      assert.deepEqual(a.errors, []);
      assert.deepEqual(b.errors, []);
    } finally {
      a.connection.leave();
      b.connection.leave();
      await mf.dispose();
      for (const [key, value] of originals) {
        if (value) Object.defineProperty(globalThis, key, value);
        else Reflect.deleteProperty(globalThis, key);
      }
    }
  },
);
