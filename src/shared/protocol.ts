/** Public, versioned signaling protocol. File metadata never travels through this channel. */
export const PROTOCOL = 2;
export const ROOM_PATTERN = /^\d{6}$/;
export const CLIENT_PATTERN = /^[a-f0-9-]{36}$/;
export const MAX_SIGNAL_BYTES = 32 * 1024;
export function normalizeRoom(input: string): string {
  return input.toLowerCase().replace(/[\s-]/g, "");
}
export function newRoom(): string {
  // Rejection sampling avoids bias; reservation at the server handles collisions.
  const range = 900000;
  const limit = Math.floor(2 ** 32 / range) * range;
  let value: number;
  do {
    value = crypto.getRandomValues(new Uint32Array(1))[0];
  } while (value >= limit);
  return String(100000 + (value % range));
}
export function displayRoom(room: string): string {
  return room;
}
export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
export function isSignal(value: unknown): value is Record<string, unknown> {
  if (
    !isRecord(value) ||
    value.type !== "signal" ||
    !isRecord(value.data) ||
    typeof value.session !== "string" ||
    !CLIENT_PATTERN.test(value.session)
  )
    return false;
  const d = value.data;
  if (d.kind === "restart") return true;
  if (d.kind === "description")
    return (
      (d.type === "offer" || d.type === "answer") &&
      typeof d.sdp === "string" &&
      d.sdp.length <= 28000
    );
  return (
    d.kind === "candidate" &&
    (d.candidate === null ||
      (isRecord(d.candidate) &&
        typeof d.candidate.candidate === "string" &&
        d.candidate.candidate.length < 2048))
  );
}
