/** Public, versioned signaling protocol. File metadata never travels through this channel. */
export const PROTOCOL = 1;
export const ROOM_PATTERN = /^[a-f0-9]{24}$/;
export const CLIENT_PATTERN = /^[a-f0-9-]{36}$/;
export const MAX_SIGNAL_BYTES = 32 * 1024;
export function normalizeRoom(input: string): string {
  return input.toLowerCase().replace(/[\s-]/g, "");
}
export function newRoom(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(12)), (n) =>
    n.toString(16).padStart(2, "0"),
  ).join("");
}
export function displayRoom(room: string): string {
  return room.match(/.{1,6}/g)?.join(" - ") ?? room;
}
export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
export function isSignal(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value) || value.type !== "signal" || !isRecord(value.data))
    return false;
  const d = value.data;
  if (d.kind === "state") return typeof d.open === "boolean";
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
