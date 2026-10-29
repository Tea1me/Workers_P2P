import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Accept conventional preview flags; execute CLIs through Node on all platforms.
const args = process.argv.slice(2);
let host = "0.0.0.0";
let port = process.env.PORT || "3000";
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--host" || args[i] === "--ip") host = args[++i] || host;
  else if (args[i] === "--port") port = args[++i] || port;
  else if (args[i] === "--strictPort") {
    /* Wrangler already requires the requested port. */
  } else {
    console.error(`Unknown argument: ${args[i]}`);
    process.exit(1);
  }
}
if (!process.env.npm_execpath) {
  console.error("Start with npm run dev");
  process.exit(1);
}
const build = spawnSync(
  process.execPath,
  [process.env.npm_execpath, "run", "build"],
  { stdio: "inherit" },
);
if (build.status !== 0) process.exit(build.status || 1);
const wrangler = fileURLToPath(
  new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url),
);
const server = spawn(
  process.execPath,
  [wrangler, "dev", "--ip", host, "--port", port],
  {
    stdio: "inherit",
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
  },
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => server.kill(signal));
server.on("error", (error) => {
  console.error(error.message);
  process.exit(1);
});
server.on("exit", (code) => process.exit(code || 0));
