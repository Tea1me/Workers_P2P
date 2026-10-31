# Validation record — NearDrop 1.3.1

Updated on 2026-10-31. Use the committed Node.js 24 lockfile.

Checks cover strict client / Worker TypeScript, unit / state-machine tests, workerd / Durable Objects, Vite production packaging, and a Wrangler deployment dry run.

Transfer tests cover the bounded 8 MiB window, old receivers without window negotiation, corruption, rejection, sink failures, cancellation, lost ACKs and verified-offset resume. New checks cover 16 KiB outbound frames, slow but progressing buffer drains beyond 30 seconds, genuinely stalled channel closure, and an exact 47 MiB + 777 byte memory download with an explicit completion phase.

Storage-isolation browser tests use the production TransferEngine, ReceiveController and OPFS sink with a simulated transport. Persistent Firefox and Chromium profiles receive 256 MiB + 321 bytes without a native save picker. The actual downloads are checked for exact size and full SHA-256. A second test disables createWritable to exercise the dedicated-worker sync-access fallback.

Separate end-to-end browser tests use the production UI, Worker signaling and actual WebRTC channels between independent persistent browser profiles. Chromium → Chromium sends 47 MiB + 777 bytes three times; Chromium → Firefox sends 347 MiB + 777 bytes twice. Each download is checked for exact size and full SHA-256. During the second Firefox transfer, test-only instrumentation forces the sender's buffer counter to stop decreasing after 50 MiB. The test requires automatic channel replacement and completion of the same file, without another accept click. No test hooks are shipped in the application.

The original unmodified real-browser baseline completed both file sizes in CI; the user's physical Chrome → Firefox stall has not been reproduced in that environment. The compatibility changes and forced-stall recovery test do not establish the original device/network-specific root cause.

The restricted executor cannot produce usable native ICE candidates; the libwebrtc integration test skips locally with an explicit reason, but missing candidates fail CI. Actual browser execution and native RTC verification are performed by repository CI.

There is no physical gigabit-LAN throughput measurement here and no promise of line-rate performance. Browser storage quota and actual hardware remain relevant. Main visual screenshot predates these functional changes; footer identifies NearDrop 1.3.1.
