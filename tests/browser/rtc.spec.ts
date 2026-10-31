import {
  test,
  expect,
  chromium,
  firefox,
  type Page,
  type BrowserContext,
} from "@playwright/test";
import { mkdtemp, open, rm, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

test.setTimeout(240000);
const APP = "http://127.0.0.1:4175";
async function hash(file: string) {
  const value = createHash("sha256");
  for await (const chunk of createReadStream(file)) value.update(chunk);
  return value.digest("hex");
}
async function sourceFile(directory: string, size: number, index: number) {
  const filename = path.join(directory, `rtc-${index}.bin`);
  const handle = await open(filename, "w");
  const block = Buffer.alloc(1024 * 1024, 0x5a);
  try {
    for (let offset = 0; offset < size; offset += block.length) {
      block.writeUInt32LE(offset / block.length, 0);
      await handle.write(
        block.subarray(0, Math.min(block.length, size - offset)),
      );
    }
  } finally {
    await handle.close();
  }
  return filename;
}
async function instrumentation(page: Page) {
  await page.addInitScript(() => {
    const target = window as unknown as {
      __rtc: RTCPeerConnection[];
      __channels: RTCDataChannel[];
      __binarySent: number;
      __stallAt?: number;
      __stallInjected?: boolean;
    };
    target.__rtc = [];
    target.__channels = [];
    target.__binarySent = 0;
    const watch = (channel: RTCDataChannel) => {
      target.__channels.push(channel);
      let stalled = false;
      const amount = Object.getOwnPropertyDescriptor(
        RTCDataChannel.prototype,
        "bufferedAmount",
      )!.get!;
      const send = channel.send.bind(channel) as (
        data: string | Blob | ArrayBuffer | ArrayBufferView,
      ) => void;
      Object.defineProperty(channel, "bufferedAmount", {
        configurable: true,
        get: () => (stalled ? 2 * 1024 * 1024 : amount.call(channel)),
      });
      Object.defineProperty(channel, "send", {
        configurable: true,
        value: (data: string | Blob | ArrayBuffer | ArrayBufferView) => {
          send(data);
          if (typeof data !== "string")
            target.__binarySent +=
              data instanceof Blob ? data.size : data.byteLength;
          if (
            target.__stallAt &&
            !target.__stallInjected &&
            target.__binarySent >= target.__stallAt
          ) {
            target.__stallInjected = true;
            stalled = true;
          }
        },
      });
      return channel;
    };
    const Native = window.RTCPeerConnection;
    window.RTCPeerConnection = class extends Native {
      constructor(configuration?: RTCConfiguration) {
        super(configuration);
        target.__rtc.push(this);
        this.addEventListener("datachannel", (event) => watch(event.channel));
      }
      createDataChannel(label: string, options?: RTCDataChannelInit) {
        return watch(super.createDataChannel(label, options));
      }
    };
  });
}
async function diagnostics(page: Page) {
  return page.evaluate(async () => {
    const target = window as unknown as {
      __rtc: RTCPeerConnection[];
      __channels: RTCDataChannel[];
    };
    const stats: unknown[] = [];
    for (const pc of target.__rtc) {
      try {
        const report = await pc.getStats();
        report.forEach((value) => {
          if (
            value.type === "data-channel" ||
            (value.type === "candidate-pair" && value.nominated)
          )
            stats.push({
              type: value.type,
              state: value.state,
              bytesSent: value.bytesSent,
              bytesReceived: value.bytesReceived,
              messagesSent: value.messagesSent,
              messagesReceived: value.messagesReceived,
              currentRoundTripTime: value.currentRoundTripTime,
            });
        });
      } catch {}
    }
    return {
      rows: [...document.querySelectorAll(".transfer-row")].map(
        (row) => row.textContent,
      ),
      channels: target.__channels.map((c) => ({
        state: c.readyState,
        buffered: c.bufferedAmount,
      })),
      stats,
    };
  });
}
async function verifyTransfer(
  sender: Page,
  receiver: Page,
  filename: string,
  round: number,
) {
  await sender.locator("#file-input").setInputFiles(filename);
  await expect(receiver.locator("#receive-dialog")).toBeVisible();
  await receiver.locator("#accept-file").click();
  const deadline = Date.now() + 180000;
  let failureSince = 0;
  while (true) {
    const sending = await sender
      .locator(".row-status")
      .nth(round)
      .textContent();
    const receiving = await receiver
      .locator(".row-status")
      .nth(round)
      .textContent();
    if (sending === "已完成" && receiving === "已完成") break;
    const failed = /暂停|失败|取消|拒绝/.test(`${sending} ${receiving}`);
    if (failed && !failureSince) failureSince = Date.now();
    if (!failed) failureSince = 0;
    if (
      (failureSince && Date.now() - failureSince > 5000) ||
      Date.now() > deadline
    )
      throw new Error(
        JSON.stringify({
          sender: await diagnostics(sender),
          receiver: await diagnostics(receiver),
        }),
      );
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const downloadPromise = receiver.waitForEvent("download");
  await receiver.locator(".download-link").nth(round).click();
  const download = await downloadPromise;
  const saved = await download.path();
  expect(saved).toBeTruthy();
  expect((await stat(saved!)).size).toBe((await stat(filename)).size);
  expect(await hash(saved!)).toBe(await hash(filename));
}
for (const target of ["chromium", "firefox"] as const) {
  test(`production UI real chromium → ${target}, full files and repeated completion`, async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "neardrop-real-ui-"),
    );
    const contexts: BrowserContext[] = [];
    try {
      const a = await chromium.launchPersistentContext(
        path.join(directory, "sender"),
        { headless: true, acceptDownloads: true },
      );
      contexts.push(a);
      const b = await (
        target === "firefox" ? firefox : chromium
      ).launchPersistentContext(path.join(directory, "receiver"), {
        headless: true,
        acceptDownloads: true,
      });
      contexts.push(b);
      const sender = await a.newPage(),
        receiver = await b.newPage();
      await instrumentation(sender);
      await instrumentation(receiver);
      await sender.goto(APP);
      await sender.locator("#create-room").click();
      await expect(sender.locator("#room-code")).toHaveText(/^\d{6}$/);
      const room = await sender.locator("#room-code").textContent();
      await receiver.goto(APP);
      await receiver.locator("#room-input").fill(room!);
      await receiver.locator("#join-form").getByRole("button").click();
      try {
        await expect(sender.locator("#connection-badge")).toHaveText("已直连", {
          timeout: 45000,
        });
        await expect(receiver.locator("#connection-badge")).toHaveText(
          "已直连",
          { timeout: 45000 },
        );
      } catch (error) {
        throw new Error(
          `${String(error)} ${JSON.stringify({ sender: await diagnostics(sender), receiver: await diagnostics(receiver) })}`,
        );
      }
      for (let round = 0; round < (target === "chromium" ? 3 : 2); round++) {
        const size = (target === "chromium" ? 47 : 347) * 1024 * 1024 + 777;
        if (target === "firefox" && round === 1)
          await sender.evaluate(() => {
            const state = window as unknown as {
              __binarySent: number;
              __stallAt: number;
            };
            state.__stallAt = state.__binarySent + 50 * 1024 * 1024;
          });
        await verifyTransfer(
          sender,
          receiver,
          await sourceFile(directory, size, round),
          round,
        );
        if (target === "firefox" && round === 1) {
          const recovery = await sender.evaluate(() => {
            const state = window as unknown as {
              __stallInjected?: boolean;
              __channels: RTCDataChannel[];
            };
            return {
              injected: state.__stallInjected,
              channels: state.__channels.length,
            };
          });
          expect(recovery.injected).toBe(true);
          expect(recovery.channels).toBeGreaterThan(1);
        }
      }
    } finally {
      for (const context of contexts) await context.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}
