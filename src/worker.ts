import { DurableObject } from "cloudflare:workers";
import {
  CLIENT_PATTERN,
  MAX_SIGNAL_BYTES,
  PROTOCOL,
  ROOM_PATTERN,
  isSignal,
} from "./shared/protocol";

interface Env {
  ASSETS: Fetcher;
  ROOMS: DurableObjectNamespace<TransferRoom>;
}
interface Attachment {
  id: string;
  name: string;
  window: number;
  count: number;
  resume: boolean;
}
const securityHeaders: Record<string, string> = {
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self' wss:; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "X-Frame-Options": "DENY",
};
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/room/")) {
      if (request.method !== "GET")
        return new Response("Method not allowed", { status: 405 });
      if (request.headers.get("Origin") !== url.origin)
        return new Response("Origin rejected", { status: 403 });
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket")
        return new Response("WebSocket required", { status: 426 });
      const room = url.pathname.slice("/api/room/".length);
      if (
        !ROOM_PATTERN.test(room) ||
        !CLIENT_PATTERN.test(url.searchParams.get("id") ?? "")
      )
        return new Response("Invalid room or client", { status: 400 });
      return env.ROOMS.get(env.ROOMS.idFromName(room)).fetch(request);
    }
    if (url.pathname === "/api/health")
      return Response.json(
        { ok: true, protocol: PROTOCOL },
        { headers: { ...securityHeaders, "Cache-Control": "no-store" } },
      );
    if (url.pathname.startsWith("/api/"))
      return new Response("Not found", { status: 404 });
    if (!["GET", "HEAD"].includes(request.method))
      return new Response("Method not allowed", { status: 405 });
    const asset = await env.ASSETS.fetch(request);
    const response = new Response(asset.body, asset);
    for (const [key, value] of Object.entries(securityHeaders))
      response.headers.set(key, value);
    if (url.pathname === "/" || url.pathname.endsWith(".html"))
      response.headers.set("Cache-Control", "no-cache");
    return response;
  },
} satisfies ExportedHandler<Env>;

/** One unguessable room, at most two devices. Hibernation keeps idle cost low. */
export class TransferRoom extends DurableObject<Env> {
  private sockets(): WebSocket[] {
    return this.ctx
      .getWebSockets()
      .filter((ws) => ws.readyState === WebSocket.OPEN);
  }
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const id = url.searchParams.get("id")!;
    const name = (url.searchParams.get("name") ?? "另一台设备")
      .slice(0, 32)
      .replace(/[\x00-\x1f]/g, "");
    // A reconnect replaces only that device's own old socket, including half-open sockets.
    for (const old of this.sockets())
      if ((old.deserializeAttachment() as Attachment).id === id)
        old.close(4001, "Replaced");
    if (this.sockets().length >= 2)
      return new Response("Room is full", { status: 409 });
    const expires = await this.ctx.storage.get<number>("expires");
    const deadline = expires ?? Date.now() + 24 * 60 * 60 * 1000;
    if (deadline <= Date.now())
      return new Response("Room expired", { status: 410 });
    // No awaits between capacity check and accept: concurrent upgrades cannot overfill a room.
    if (this.sockets().length >= 2)
      return new Response("Room is full", { status: 409 });
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({
      id,
      name,
      window: Date.now(),
      count: 0,
      resume: url.searchParams.get("resume") === "1",
    } satisfies Attachment);
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", "pong"),
    );
    if (!expires) {
      await this.ctx.storage.put("expires", deadline);
      await this.ctx.storage.setAlarm(deadline);
    }
    server.send(
      JSON.stringify({
        type: "welcome",
        protocol: PROTOCOL,
        id,
        expires: deadline,
      }),
    );
    const peers = this.sockets();
    if (peers.length === 2) {
      const initiator = (peers[0].deserializeAttachment() as Attachment).id;
      // Fresh channels can negotiate immediately; retained channels still probe each other.
      const fresh = peers.every(
        (peer) => !(peer.deserializeAttachment() as Attachment).resume,
      );
      for (const peer of peers) {
        const other = peers.find((p) => p !== peer)!;
        const info = other.deserializeAttachment() as Attachment;
        peer.send(
          JSON.stringify({
            type: "paired",
            initiator,
            fresh,
            peer: { id: info.id, name: info.name },
          }),
        );
      }
    }
    return new Response(null, { status: 101, webSocket: client });
  }
  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    if (typeof message !== "string" || message.length > MAX_SIGNAL_BYTES) {
      ws.close(1009, "Signal too large");
      return;
    }
    const attachment = ws.deserializeAttachment() as Attachment;
    const now = Date.now();
    if (now - attachment.window > 10000) {
      attachment.window = now;
      attachment.count = 0;
    }
    if (++attachment.count > 180) {
      ws.close(1008, "Rate limited");
      return;
    }
    ws.serializeAttachment(attachment);
    try {
      const data: unknown = JSON.parse(message);
      if (!isSignal(data)) {
        ws.close(1008, "Invalid signal");
        return;
      }
      for (const peer of this.sockets())
        if (peer !== ws) peer.send(JSON.stringify(data));
    } catch {
      ws.close(1008, "Invalid JSON");
    }
  }
  webSocketClose(ws: WebSocket, code: number, reason: string): void {
    ws.close(code, reason);
    // A superseded socket must not announce that the replacement left.
    const id = (ws.deserializeAttachment() as Attachment).id;
    if (
      this.sockets().some(
        (p) => (p.deserializeAttachment() as Attachment).id === id,
      )
    )
      return;
    for (const peer of this.sockets())
      peer.send(JSON.stringify({ type: "peer-left" }));
  }
  webSocketError(ws: WebSocket): void {
    ws.close(1011, "Socket error");
  }
  async alarm(): Promise<void> {
    for (const ws of this.sockets()) ws.close(4002, "Room expired");
    await this.ctx.storage.deleteAll();
  }
}
