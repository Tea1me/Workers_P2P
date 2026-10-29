import { build } from "esbuild";
import {
  Miniflare,
  convertV4MiniflareOptions,
  type WebSocket,
} from "miniflare";
export async function createRuntime(): Promise<Miniflare> {
  const result = await build({
    entryPoints: ["src/worker.ts"],
    bundle: true,
    format: "esm",
    write: false,
    external: ["cloudflare:workers"],
    target: "es2022",
  });
  return new Miniflare(
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
}
export async function createRoom(mf: Miniflare, ip = "local"): Promise<string> {
  const response = await mf.dispatchFetch("https://near.test/api/rooms", {
    method: "POST",
    headers: { Origin: "https://near.test", "CF-Connecting-IP": ip },
  });
  if (response.status !== 201)
    throw new Error(`Create room failed: ${response.status}`);
  return ((await response.json()) as { room: string }).room;
}
export function connect(
  mf: Miniflare,
  room: string,
  id = crypto.randomUUID(),
  ready = false,
) {
  return mf.dispatchFetch(
    `https://near.test/api/room/${room}?id=${id}&name=Test&ready=${ready ? 1 : 0}`,
    { headers: { Upgrade: "websocket", Origin: "https://near.test" } },
  );
}
export function next(ws: WebSocket): Promise<Record<string, unknown>> {
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
