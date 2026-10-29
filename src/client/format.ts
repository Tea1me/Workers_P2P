export function bytes(value: number): string {
  if (!value) return "0 B";
  const i = Math.min(4, Math.floor(Math.log(value) / Math.log(1024)));
  return `${(value / 1024 ** i).toFixed(i === 0 ? 0 : value / 1024 ** i >= 100 ? 0 : 1)} ${["B", "KB", "MB", "GB", "TB"][i]}`;
}
export function safeName(name: string): string {
  const clean = name
    .replace(/[\x00-\x1f<>:"/\\|?*]/g, "_")
    .replace(/^\.+|[. ]+$/g, "")
    .slice(0, 180);
  return clean || "未命名文件";
}
export function deviceName(): string {
  const ua = navigator.userAgent;
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1))
    return "iPad";
  if (/iPhone/.test(ua)) return "iPhone";
  if (/Android/.test(ua)) return "Android";
  if (/Windows/.test(ua)) return "Windows PC";
  if (/Mac/.test(ua)) return "Mac";
  return "我的设备";
}
