import { test as base, expect, chromium, firefox } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
const test = base.extend({
  context: async ({ browserName }, use) => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "neardrop-browser-"),
    );
    const context = await (
      browserName === "firefox" ? firefox : chromium
    ).launchPersistentContext(directory, {
      headless: true,
      acceptDownloads: true,
    });
    try {
      await use(context);
    } finally {
      await context.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
});
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import type {} from "./fixture";

test("large file receives through OPFS with no native save picker, downloads intact, and cleans up", async ({
  page,
}) => {
  await page.goto("http://127.0.0.1:4174/");
  const size = 256 * 1024 * 1024 + 321;
  const result = await page.evaluate(
    (size) => window.regression.run(size),
    size,
  );
  expect(result.size).toBe(size);
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("link", { name: "保存文件" }).click();
  const download = await downloadPromise;
  const path = await download.path();
  expect(path).toBeTruthy();
  expect((await stat(path!)).size).toBe(size);
  const actual = createHash("sha256");
  for await (const chunk of createReadStream(path!)) actual.update(chunk);
  const expected = createHash("sha256");
  const chunk = Buffer.alloc(1024 * 1024, 0x5a);
  for (let i = 0; i < 256; i++) expected.update(chunk);
  expected.update(chunk.subarray(0, 321));
  expect(actual.digest("hex")).toBe(expected.digest("hex"));
  await page.evaluate(() => window.regression.cleanup());
});

test("OPFS worker fallback also supports reception when createWritable is missing", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(FileSystemFileHandle.prototype, "createWritable", {
      value: undefined,
      configurable: true,
    });
  });
  await page.goto("http://127.0.0.1:4174/");
  const result = await page.evaluate(() =>
    window.regression.run(2 * 1024 * 1024 + 3),
  );
  expect(result.size).toBe(2 * 1024 * 1024 + 3);
  await page.evaluate(() => window.regression.cleanup());
});
