import { DurableObject } from "cloudflare:workers";
import {
  CLIENT_PATTERN,
  MAX_SIGNAL_BYTES,
  PROTOCOL,
  ROOM_PATTERN,
  isSignal,
  isRecord,
  newRoom,
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
  ready: boolean;
  session?: string;
}
const ROOM_TTL = 60 * 60 * 1000;
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
    if (url.pathname === "/api/rooms") {
      if (request.method !== "POST")
        return new Response("Method not allowed", { status: 405 });
      if (request.headers.get("Origin") !== url.origin)
        return new Response("Origin rejected", { status: 403 });
      const limit = await rateLimit(request, env, "create");
      if (limit) return limit;
      for (let attempt = 0; attempt < 8; attempt++) {
        const room = newRoom();
        const result = await env.ROOMS.get(env.ROOMS.idFromName(room)).fetch(
          new Request("https://internal/reserve", { method: "POST" }),
        );
        if (result.ok)
          return Response.json(
            { room },
            {
              status: 201,
              headers: { ...securityHeaders, "Cache-Control": "no-store" },
            },
          );
      }
      return Response.json(
        { error: "暂时无法创建房间，请稍后再试" },
        { status: 503 },
      );
    }
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
      const limit = await rateLimit(request, env, "join");
      if (limit) return limit;
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

async function rateLimit(
  request: Request,
  env: Env,
  operation: "create" | "join",
): Promise<Response | undefined> {
  const ip = request.headers.get("CF-Connecting-IP") ?? "local";
  const guard = env.ROOMS.get(env.ROOMS.idFromName(`limit:${ip}`));
  const result = await guard.fetch(
    new Request(`https://internal/limit?op=${operation}`, { method: "POST" }),
  );
  if (!result.ok)
    return new Response("操作过于频繁，请一分钟后重试", {
      status: 429,
      headers: { "Retry-After": "60", "Cache-Control": "no-store" },
    });
}
function socketError(message: string): Response {
  const [client, server] = Object.values(new WebSocketPair());
  server.accept();
  server.send(JSON.stringify({ type: "error", message }));
  server.close(4004, "Room unavailable");
  return new Response(null, { status: 101, webSocket: client });
}
/** Reserved numeric room codes and a separate per-IP request bucket share this class. */
export class TransferRoom extends DurableObject<Env> {
  private sockets(): WebSocket[] {
    return this.ctx
      .getWebSockets()
      .filter((ws) => ws.readyState === WebSocket.OPEN);
  }
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/reserve" && request.method === "POST") {
      return this.ctx.blockConcurrencyWhile(async () => {
        const expires = await this.ctx.storage.get<number>("expires");
        if ((expires ?? 0) > Date.now() || this.sockets().length)
          return new Response("Occupied", { status: 409 });
        const deadline = Date.now() + ROOM_TTL;
        await this.ctx.storage.put("expires", deadline);
        await this.ctx.storage.setAlarm(deadline);
        return new Response(null, { status: 201 });
      });
    }
    if (url.pathname === "/limit") {
      const op = url.searchParams.get("op") === "create" ? "create" : "join";
      const allowed = await this.ctx.storage.transaction(async (txn) => {
        const now = Date.now();
        const old = await txn.get<{
          window: number;
          create: number;
          join: number;
        }>("quota");
        const quota =
          old && now - old.window < 60000
            ? old
            : { window: now, create: 0, join: 0 };
        if (quota[op] >= (op === "create" ? 20 : 60)) return false;
        quota[op]++;
        await txn.put("quota", quota);
        return true;
      });
      await this.ctx.storage.setAlarm(Date.now() + 120000);
      return new Response(null, { status: allowed ? 204 : 429 });
    }
    const id = url.searchParams.get("id")!;
    const name = (url.searchParams.get("name") ?? "另一台设备")
      .slice(0, 32)
      .replace(/[\x00-\x1f]/g, "");
    const expires = await this.ctx.storage.get<number>("expires");
    if (!expires || expires <= Date.now())
      return socketError("房间不存在或已过期，请重新创建 6 位数字房间");
    // A reconnect replaces only that device's own old socket, including half-open sockets.
    for (const old of this.sockets())
      if ((old.deserializeAttachment() as Attachment).id === id)
        old.close(4001, "Replaced");
    if (this.sockets().length >= 2)
      return socketError("房间已有两台设备，请退出旧页面或创建新房间");
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({
      id,
      name,
      window: Date.now(),
      count: 0,
      ready: url.searchParams.get("ready") === "1",
    } satisfies Attachment);
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", "pong"),
    );
    server.send(
      JSON.stringify({
        type: "welcome",
        protocol: PROTOCOL,
        id,
        expires,
      }),
    );
    const peers = this.sockets();
    if (peers.length === 2) {
      const initiator = (peers[0].deserializeAttachment() as Attachment).id;
      const session = crypto.randomUUID();
      const negotiate = !peers.every(
        (peer) => (peer.deserializeAttachment() as Attachment).ready,
      );
      for (const peer of peers) {
        const other = peers.find((p) => p !== peer)!;
        const info = other.deserializeAttachment() as Attachment;
        const attachment = peer.deserializeAttachment() as Attachment;
        peer.serializeAttachment({ ...attachment, session });
        peer.send(
          JSON.stringify({
            type: "paired",
            initiator,
            session,
            negotiate,
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
      if (
        isRecord(data) &&
        data.type === "status" &&
        typeof data.session === "string" &&
        CLIENT_PATTERN.test(data.session) &&
        typeof data.open === "boolean"
      ) {
        // A channel can close just as a new pair is created. Ignore its late health update.
        if (data.session === attachment.session)
          ws.serializeAttachment({ ...attachment, ready: data.open });
        return;
      }
      if (!isSignal(data)) {
        ws.close(1008, "Invalid signal");
        return;
      }
      // Late candidates / SDP from a replaced session must never reach the new connection.
      if (data.session !== attachment.session) return;
      for (const peer of this.sockets())
        if (
          peer !== ws &&
          (peer.deserializeAttachment() as Attachment).session === data.session
        )
          peer.send(JSON.stringify(data));
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
