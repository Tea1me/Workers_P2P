# Validation record

Checked on 2026-10-29 with Node.js 24, the committed npm lockfile, and Wrangler 4.155.0.

- Strict client and Worker TypeScript checks: passed.
- Protocol and file transfer tests: 17 passed.
- Miniflare / workerd integration tests: 5 passed. These exercise actual WebSocket upgrades and SQLite Durable Objects, rather than mocks of the Cloudflare runtime.
- Vite production build and Wrangler deployment dry run: passed.
- npm dependency audit: zero reported vulnerabilities at verification time.
- Desktop browser: layout, help dialog, and the explicit HTTPS requirement verified. Preview screenshot is `preview.jpg`.

The preview origin is plain HTTP (`terminal.local`), so browser Web Crypto is unavailable there. No real two-device WebRTC transfer, cross-browser mobile test, physical LAN throughput benchmark, or deployment into the owner's Cloudflare account has been performed in this environment. Transfer tests use the real application state machine with an in-memory transport; they validate correctness and recovery behavior, not network throughput. Complete the post-deployment acceptance steps in the README on the target devices.
