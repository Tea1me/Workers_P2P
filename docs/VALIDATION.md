# Validation record — NearDrop 1.3

Updated on 2026-10-31. Use the committed Node.js 24 lockfile.

Checks cover strict client / Worker TypeScript, unit / state-machine tests, workerd / Durable Objects, Vite production packaging, and a Wrangler deployment dry run.

New transfer tests hold acknowledgements to verify that multiple blocks are sent before the first ACK, that the sender stops at the negotiated window, and that old receivers without an advertised window retain one-block flow control. Integrity, rejection, sink failure, cancellation, lost ACKs, and verified-offset resume remain covered. A real libwebrtc test sends more than one entire window, reconnects a peer, and sends back.

Browser regression runs use persistent Firefox and Chromium profiles on a local secure-context origin. They exercise the production TransferEngine, ReceiveController, and OPFS sink to receive 256 MiB + 321 bytes without a native save picker. The actual browser download is checked for exact size and full SHA-256. A second test disables createWritable in the page to exercise the dedicated-worker sync-access fallback. Test fixtures are built separately into ignored output and are never shipped as application assets.

The restricted executor cannot produce usable native ICE candidates; that native-RTC test skips locally with an explicit reason, but missing candidates fail CI. Browser execution and native RTC verification are performed by repository CI. Browser tests simulate the RTC transport to isolate storage compatibility; they are not a Firefox-to-Chromium network benchmark. The real libwebrtc test covers the network protocol separately.

There is no physical gigabit-LAN throughput measurement here and no promise of line-rate performance. Browser storage space / quota and actual hardware remain relevant. Main visual screenshot predates these functional changes; footer now identifies NearDrop 1.3.
