import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
const root = path.resolve(".browser-tests");
http
  .createServer(async (request, response) => {
    const pathname = new URL(request.url, "http://localhost").pathname;
    const file = path.resolve(
      root,
      pathname === "/" ? "index.html" : "." + pathname,
    );
    if (!file.startsWith(root + path.sep)) {
      response.writeHead(403).end();
      return;
    }
    try {
      const bytes = await fs.readFile(file);
      response.writeHead(200, {
        "Content-Type": file.endsWith(".html")
          ? "text/html"
          : "text/javascript",
        "Cache-Control": "no-store",
      });
      response.end(bytes);
    } catch {
      response.writeHead(404).end();
    }
  })
  .listen(4174, "127.0.0.1");
