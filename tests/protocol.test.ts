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
test("room keys carry 96 random bits and round trip through display", () => {
  const rooms = new Set(Array.from({ length: 1000 }, newRoom));
  assert.equal(rooms.size, 1000);
  for (const room of rooms) {
    assert.match(room, ROOM_PATTERN);
    assert.equal(normalizeRoom(displayRoom(room).toUpperCase()), room);
  }
});
test("signaling accepts SDP / ICE and rejects file data and malformed values", () => {
  assert.ok(
    isSignal({
      type: "signal",
      data: { kind: "description", type: "offer", sdp: "v=0" },
    }),
  );
  assert.ok(
    isSignal({
      type: "signal",
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
      data: { kind: "description", type: "rollback", sdp: "x" },
    },
    {
      type: "signal",
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
