import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isSignal,
  newRoom,
  normalizeRoom,
  ROOM_PATTERN,
  displayRoom,
} from "../src/shared/protocol";
import { safeName, bytes } from "../src/client/format";
import { validMetadata } from "../src/client/transfer";
test("room codes are six digits and can be pasted with spacing", () => {
  for (let i = 0; i < 100; i++) {
    const room = newRoom();
    assert.match(room, /^[1-9]\d{5}$/);
    assert.equal(normalizeRoom(displayRoom(room)), room);
  }
  assert.equal(normalizeRoom("123 456"), "123456");
  assert.equal(ROOM_PATTERN.test("abcdef1234567890abcdef12"), false);
});
test("signaling accepts SDP / ICE and rejects file data and malformed values", () => {
  assert.ok(
    isSignal({
      type: "signal",
      session: crypto.randomUUID(),
      data: { kind: "description", type: "offer", sdp: "v=0" },
    }),
  );
  assert.ok(
    isSignal({
      type: "signal",
      session: crypto.randomUUID(),
      data: { kind: "candidate", candidate: { candidate: "candidate:1" } },
    }),
  );
  for (const data of [
    null,
    [],
    "x",
    { type: "file" },
    {
      type: "signal",
      session: crypto.randomUUID(),
      data: { kind: "description", type: "rollback", sdp: "x" },
    },
    {
      type: "signal",
      session: crypto.randomUUID(),
      data: { kind: "description", type: "offer", sdp: "x".repeat(30000) },
    },
  ])
    assert.equal(isSignal(data), false);
});
test("untrusted file metadata cannot request invalid allocations", () => {
  const meta = {
    id: crypto.randomUUID(),
    name: "test.bin",
    size: 12,
    mime: "",
    modified: 0,
  };
  assert.ok(validMetadata(meta));
  for (const size of [-1, NaN, Infinity, 0.5, 2 ** 52])
    assert.equal(validMetadata({ ...meta, size }), false);
  assert.equal(validMetadata({ ...meta, name: "x".repeat(513) }), false);
});
test("download names strip paths / control characters and formatting handles zero", () => {
  assert.equal(safeName("../hello\\world\u0000.txt"), "_hello_world_.txt");
  assert.equal(safeName("..."), "未命名文件");
  assert.equal(bytes(0), "0 B");
  assert.equal(bytes(1024), "1.0 KB");
});
