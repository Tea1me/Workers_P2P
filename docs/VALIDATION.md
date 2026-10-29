# Validation record — NearDrop 1.2

Checked on 2026-10-29 with Node.js 24, the committed lockfile, and Wrangler 4.155.0.

- Strict client and Worker TypeScript checks.
- 31 unit / state-machine tests: receive flow, transfer integrity / resume, session isolation, candidate buffering, and bounded ICE restart.
- 9 workerd / Durable Object integration tests: numeric allocation, atomic collision handling, readable missing / full rooms, per-IP limits, stale-session filtering, and ready-state preservation.
- One real libwebrtc integration test: production Connection and TransferEngine clients exchange actual ICE / SDP through the production Worker, establish DTLS / SCTP data channels, transfer a multi-block file with matching SHA-256, reconnect one side, and send a file in the reverse direction.
- Vite production build and Wrangler deployment dry run.

The restricted local executor does not expose usable native ICE candidates, so the real libwebrtc test skips there with an explicit reason. In GitHub CI this test is mandatory: missing native ICE candidates cause a failure, not a skip. The real test disables external STUN only for loopback determinism; the production client uses Cloudflare's public STUN endpoint. It tests actual network transport and production signaling, but is not a physical phone / desktop browser compatibility test, a public STUN reachability test, or a LAN throughput benchmark.

The older screenshot shows the main visual design. Current room codes are six digits and the main receive button is always “接收文件”. New UI / protocol is identified by NearDrop 1.2 in the footer. Physical-device acceptance remains necessary for the owner's network and browser combination.
