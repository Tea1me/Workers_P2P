import "./style.css";
import { Connection, type ConnectionState } from "./connection";
import {
  TransferEngine,
  MEMORY_LIMIT,
  type Progress,
  type Sink,
} from "./transfer";
import { normalizeRoom, ROOM_PATTERN, displayRoom } from "../shared/protocol";
import { bytes, deviceName, safeName } from "./format";
import { hydrateIcons, icon } from "./icons";
import { ReceiveController, type SavePicker } from "./receive";
import { createTemporarySink, hasTemporaryStorage } from "./storage";

const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;
hydrateIcons();
const name = deviceName();
$("device-name").textContent = name;
let room = "";
let peerName = "另一台设备";
let toastTimer: ReturnType<typeof setTimeout>;
function toast(message: string): void {
  $("toast").textContent = message;
  $("toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    $("toast").hidden = true;
  }, 6000);
}
const labels: Record<ConnectionState, string> = {
  offline: "未连接",
  joining: "加入中",
  waiting: "等待设备",
  connecting: "连接中",
  connected: "已直连",
  reconnecting: "重连中",
  failed: "连接异常",
};
const connection = new Connection({
  state: (state, detail) => {
    const badge = $("connection-badge");
    badge.textContent = labels[state];
    badge.className = `badge ${state === "connected" ? "connected" : ["joining", "connecting", "reconnecting"].includes(state) ? "pending" : ""}`;
    $("peer-detail").textContent =
      detail ??
      {
        waiting: "在另一台设备上打开邀请链接",
        connecting: "正在建立加密数据通道…",
        connected: "加密通道已就绪，可以开始传输",
        joining: "正在连接配对服务…",
        offline: "分享邀请链接，即可建立连接",
        failed: "请检查网络后重新连接",
        reconnecting: "正在恢复连接…",
      }[state];
    if (state === "waiting") $("peer-name").textContent = "等待另一台设备…";
    $("drop-hint").innerHTML = icon("lock");
    $("drop-hint").append(
      document.createTextNode(
        state === "connected"
          ? "设备已连接，接收方确认后开始传输"
          : "先连接设备，也可以提前选择文件",
      ),
    );
    $("reconnect-button").hidden = ["joining", "connecting"].includes(state);
    $("peer-icon").innerHTML = icon(state === "connected" ? "laptop" : "radar");
    updateControls();
    if (state === "failed" && detail) toast(detail);
  },
  peer: (value) => {
    peerName = value;
    $("peer-name").textContent = value;
  },
  message: (data) => {
    void engine.receive(data);
  },
  ready: () => {
    toast(`已连接 ${peerName}`);
    void pump();
  },
  lost: () => {
    engine.disconnected();
    if (receiveDialog.open) receiveDialog.close("reject");
    updateControls();
  },
  route: (text) => {
    $("network-label").textContent = text;
  },
});
interface Row {
  el: HTMLElement;
  status: string;
  url?: string;
  sampleBytes: number;
  sampleTime: number;
  speed: number;
  renderedAt?: number;
  blobSize?: number;
  release?: () => Promise<void>;
}
const rows = new Map<string, Row>();
const receiveDialog = $<HTMLDialogElement>("receive-dialog");
const pickerAPI = (window as unknown as { showSaveFilePicker?: SavePicker })
  .showSaveFilePicker;
const savePicker =
  typeof pickerAPI === "function" ? pickerAPI.bind(window) : undefined;
const engine = new TransferEngine(connection, {
  offer: (meta) =>
    new Promise((resolve) => {
      $("receive-name").textContent = meta.name;
      $("receive-size").textContent = bytes(meta.size);
      $("receive-description").textContent =
        `${peerName} 想向你发送一个文件。仅接收你信任的内容。`;
      const accept = $<HTMLButtonElement>("accept-file");
      const fallback = $<HTMLButtonElement>("download-fallback");
      let decision: { sink?: Sink } | null = null;
      const controller = new ReceiveController(
        meta,
        savePicker,
        {
          render: (view) => {
            accept.disabled = view.disabled;
            accept.innerHTML = icon("download");
            accept.append(document.createTextNode(view.label));
            fallback.hidden = !view.fallback;
            fallback.textContent = view.alternateLabel;
            $("save-hint").textContent = view.hint;
            $("save-hint").classList.toggle("receive-error", view.error);
          },
          accept: (result) => {
            decision = result;
            receiveDialog.close("accept");
          },
        },
        hasTemporaryStorage() ? () => createTemporarySink(meta) : undefined,
      );
      receiveDialog.addEventListener(
        "close",
        () => {
          controller.close();
          accept.onclick = null;
          fallback.onclick = null;
          resolve(decision);
        },
        { once: true },
      );
      accept.onclick = () => {
        void controller.accept();
      };
      fallback.onclick = () => {
        void controller.alternate();
      };
      receiveDialog.showModal();
    }),
  progress: (progress) => {
    const row = rows.get(progress.id);
    if (
      (progress.status === "sending" || progress.status === "receiving") &&
      row?.status === progress.status &&
      performance.now() - (row.renderedAt ?? 0) < 100
    )
      return;
    if (progress.direction === "send" && activeQueue) {
      removeRow(activeQueue.id);
    }
    renderProgress(progress);
    updateControls();
    if (
      ["completed", "rejected", "cancelled", "error"].includes(progress.status)
    )
      setTimeout(() => {
        void pump();
        updateControls();
      }, 0);
    if (progress.status === "error") toast(progress.detail ?? "传输失败");
    void updateWakeLock();
  },
  download: (meta, blob, release) => {
    let row = rows.get(meta.id);
    if (!row) {
      renderProgress({
        ...meta,
        bytes: meta.size,
        direction: "receive",
        status: "completed",
      });
      row = rows.get(meta.id)!;
    }
    let retained = Array.from(rows.values()).reduce(
      (sum, r) => sum + (r.blobSize ?? 0),
      0,
    );
    for (const old of rows.values()) {
      if (retained + blob.size <= MEMORY_LIMIT * 2) break;
      if (old.url && old.blobSize) {
        URL.revokeObjectURL(old.url);
        old.url = undefined;
        retained -= old.blobSize ?? 0;
        old.blobSize = 0;
        old.el.querySelector(".download-link")?.remove();
        old.el.querySelector(".row-detail")!.append(" · 下载链接已释放");
      }
    }
    const url = URL.createObjectURL(blob);
    row.url = url;
    row.blobSize = release ? 0 : blob.size;
    row.release = release;
    const link = document.createElement("a");
    link.className = "download-link";
    link.href = url;
    link.download = safeName(meta.name);
    link.textContent = "保存文件";
    row.el.querySelector(".row-content")!.append(link);
    toast("文件已接收并通过校验，请点击「保存文件」");
  },
  error: (message) => {
    if (receiveDialog.open) receiveDialog.close("reject");
    toast(`传输异常：${message}`);
  },
});

function createRow(id: string, fileName: string): Row {
  const el = document.createElement("div");
  el.className = "transfer-row";
  el.dataset.id = id;
  el.innerHTML = `<span class="row-icon">${icon("file")}</span><div class="row-content"><div class="row-name"></div><div class="row-detail"></div><div class="progress-track"><div class="progress-fill"></div></div></div><div class="row-status"></div>`;
  el.querySelector(".row-name")!.textContent = fileName;
  const row: Row = {
    el,
    status: "queued",
    sampleBytes: 0,
    sampleTime: performance.now(),
    speed: 0,
  };
  rows.set(id, row);
  $("transfer-list").append(el);
  updateCount();
  return row;
}
function updateCount(): void {
  $("activity-count").textContent = String(rows.size);
  $("empty-state").hidden = rows.size > 0;
}
function removeRow(id: string): void {
  const row = rows.get(id);
  if (!row) return;
  if (row.url) URL.revokeObjectURL(row.url);
  void row.release?.().catch(() => toast("临时文件未能清理，稍后可重试"));
  row.el.remove();
  rows.delete(id);
  updateCount();
}
const statusText = {
  waiting: "等待确认",
  sending: "发送中",
  receiving: "接收中",
  paused: "已暂停",
  completed: "已完成",
  rejected: "已拒绝",
  error: "失败",
  cancelled: "已取消",
};
function renderProgress(p: Progress): void {
  const row = rows.get(p.id) ?? createRow(p.id, p.name);
  const now = performance.now();
  if (p.bytes < row.sampleBytes || p.status === "waiting") {
    row.sampleBytes = p.bytes;
    row.sampleTime = now;
    row.speed = 0;
  }
  if (now - row.sampleTime > 400) {
    row.speed = Math.max(
      0,
      (p.bytes - row.sampleBytes) / ((now - row.sampleTime) / 1000),
    );
    row.sampleBytes = p.bytes;
    row.sampleTime = now;
  }
  row.status = p.status;
  row.renderedAt = now;
  const percent = p.size
    ? Math.min(100, (p.bytes / p.size) * 100)
    : p.status === "completed"
      ? 100
      : 0;
  const detail = row.el.querySelector(".row-detail")!;
  detail.textContent = `${p.direction === "send" ? "发送" : "接收"} · ${bytes(p.bytes)} / ${bytes(p.size)}${["sending", "receiving"].includes(p.status) && row.speed ? ` · ${bytes(row.speed)}/s` : ""}${p.detail ? ` · ${p.detail}` : ""}`;
  (row.el.querySelector(".progress-fill") as HTMLElement).style.width =
    `${percent}%`;
  const status = row.el.querySelector(".row-status")!;
  status.textContent = ["sending", "receiving"].includes(p.status)
    ? `${Math.floor(percent)}%`
    : statusText[p.status];
  status.classList.toggle("done", p.status === "completed");
}
interface Queued {
  id: string;
  file: File;
}
const queue: Queued[] = [];
let activeQueue: Queued | undefined;
let pumping = false;
async function pump(resume = false): Promise<void> {
  if (pumping || !connection.open) return;
  if (engine.busy && !(resume && engine.resumable)) return;
  pumping = true;
  try {
    while (connection.open && (queue.length || (resume && engine.resumable))) {
      activeQueue = queue[0];
      const status =
        resume && engine.resumable
          ? await engine.resume()
          : activeQueue
            ? await engine.send(activeQueue.file)
            : "cancelled";
      resume = false;
      if (status === "paused") break;
      if (activeQueue && queue[0] === activeQueue) queue.shift();
      activeQueue = undefined;
    }
  } catch (error) {
    toast((error as Error).message);
  } finally {
    pumping = false;
    updateControls();
  }
}
function updateControls(): void {
  // State callbacks may fire during startup, before engine initialization.
  $("resume-button").hidden = !engine.resumable || !connection.open;
  $("cancel-button").hidden = !engine.busy && queue.length === 0;
}
function supported(): boolean {
  if (!window.isSecureContext || !crypto.subtle || !crypto.randomUUID) {
    toast("请使用 HTTPS 或 localhost 打开本站，才能安全传输文件");
    return false;
  }
  if (!window.RTCPeerConnection) {
    toast(
      "此浏览器不支持 WebRTC，请使用最新版 Chrome、Edge、Safari 或 Firefox",
    );
    return false;
  }
  return true;
}
function addFiles(files: FileList | File[]): void {
  if (!supported()) return;
  const incoming = Array.from(files);
  if (!incoming.length) return;
  if (queue.length + incoming.length > 100) {
    toast("队列最多容纳 100 个文件，请分批添加");
    return;
  }
  for (const file of incoming) {
    const item = { id: crypto.randomUUID(), file };
    queue.push(item);
    const row = createRow(item.id, file.name);
    row.el.querySelector(".row-detail")!.textContent =
      `${bytes(file.size)} · 等待发送`;
    row.el.querySelector(".row-status")!.textContent = "排队中";
  }
  updateControls();
  if (!connection.open) toast("文件已加入队列，连接设备后即可发送");
  else void pump();
}
const fileInput = $<HTMLInputElement>("file-input");
const dropZone = $("drop-zone");
dropZone.onclick = () => fileInput.click();
dropZone.onkeydown = (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    fileInput.click();
  }
};
fileInput.onchange = () => {
  if (fileInput.files) addFiles(fileInput.files);
  fileInput.value = "";
};
let dragDepth = 0;
dropZone.ondragenter = (event) => {
  event.preventDefault();
  ++dragDepth;
  dropZone.classList.add("dragover");
};
dropZone.ondragover = (event) => {
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
};
dropZone.ondragleave = () => {
  if (--dragDepth <= 0) dropZone.classList.remove("dragover");
};
dropZone.ondrop = (event) => {
  event.preventDefault();
  dragDepth = 0;
  dropZone.classList.remove("dragover");
  if (event.dataTransfer) addFiles(event.dataTransfer.files);
};
window.addEventListener("dragover", (event) => event.preventDefault());
window.addEventListener("drop", (event) => event.preventDefault());

function join(value: string): void {
  if (!supported()) return;
  if (engine.busy) {
    toast("切换房间前，请先完成或取消当前传输");
    return;
  }
  try {
    let candidate = value.trim();
    if (/^https?:\/\//i.test(candidate)) {
      const url = new URL(candidate);
      candidate = new URLSearchParams(url.hash.slice(1)).get("room") ?? "";
    }
    candidate = normalizeRoom(candidate);
    if (!ROOM_PATTERN.test(candidate)) {
      toast("请输入 6 位数字房间码，或粘贴邀请链接");
      return;
    }
    room = candidate;
    history.replaceState(null, "", `#room=${room}`);
    $("room-start").hidden = true;
    $("room-active").hidden = false;
    $("room-code").textContent = displayRoom(room);
    connection.join(room, name);
  } catch (error) {
    toast((error as Error).message);
  }
}
$("create-room").onclick = async () => {
  if (!supported()) return;
  if (engine.busy) {
    toast("请先完成或取消当前传输");
    return;
  }
  const button = $<HTMLButtonElement>("create-room");
  button.disabled = true;
  try {
    const response = await fetch("/api/rooms", { method: "POST" });
    if (!response.ok)
      throw new Error(
        response.status === 429
          ? "操作过于频繁，请一分钟后重试"
          : "创建房间失败，请检查网络后重试",
      );
    const result = (await response.json()) as { room: string };
    join(result.room);
  } catch (error) {
    toast((error as Error).message);
  } finally {
    button.disabled = false;
  }
};
$("join-form").onsubmit = (event) => {
  event.preventDefault();
  join($<HTMLInputElement>("room-input").value);
};
async function copy(value: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(value);
    toast("已复制，发送给另一台设备即可");
  } catch {
    toast("复制不可用，请手动复制地址栏中的邀请链接");
  }
}
$("copy-link").onclick = () => {
  void copy(`${location.origin}/#room=${room}`);
};
$("copy-code").onclick = () => {
  void copy(displayRoom(room));
};
$("reconnect-button").onclick = () => connection.reconnect();
$("leave-button").onclick = async () => {
  if (engine.busy && !window.confirm("退出房间会取消当前传输。确定退出？"))
    return;
  if (receiveDialog.open) receiveDialog.close("reject");
  await engine.cancel();
  connection.leave();
  room = "";
  history.replaceState(null, "", location.pathname);
  $("room-start").hidden = false;
  $("room-active").hidden = true;
  $("network-label").textContent = "请将两台设备连接到同一局域网";
};
$("resume-button").onclick = () => {
  void pump(true);
};
$("cancel-button").onclick = async () => {
  for (const item of queue) removeRow(item.id);
  queue.length = 0;
  activeQueue = undefined;
  if (receiveDialog.open) receiveDialog.close("reject");
  await engine.cancel();
  updateControls();
};
$("clear-button").onclick = () => {
  for (const [id, row] of rows)
    if (["completed", "rejected", "cancelled", "error"].includes(row.status))
      removeRow(id);
};
$("help-button").onclick = () =>
  $<HTMLDialogElement>("help-dialog").showModal();
for (const dialog of document.querySelectorAll("dialog"))
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) {
      const rect = dialog.getBoundingClientRect();
      if (
        event.clientX < rect.left ||
        event.clientX > rect.right ||
        event.clientY < rect.top ||
        event.clientY > rect.bottom
      )
        dialog.close("reject");
    }
  });
window.addEventListener("beforeunload", (event) => {
  if (
    engine.busy ||
    queue.length ||
    Array.from(rows.values()).some((r) => r.url)
  ) {
    event.preventDefault();
    event.returnValue = "";
  }
});
window.addEventListener("online", () => {
  if (room && !connection.open) connection.reconnect();
});
let wakeLock: WakeLockSentinel | undefined;
async function updateWakeLock(): Promise<void> {
  const active = Array.from(rows.values()).some((r) =>
    ["sending", "receiving"].includes(r.status),
  );
  try {
    if (active && !wakeLock && document.visibilityState === "visible") {
      wakeLock = await navigator.wakeLock?.request("screen");
      wakeLock?.addEventListener("release", () => {
        wakeLock = undefined;
      });
    } else if (!active && wakeLock) {
      await wakeLock.release();
      wakeLock = undefined;
    }
  } catch {
    /* unsupported or battery policy */
  }
}
document.addEventListener("visibilitychange", () => {
  void updateWakeLock();
});
const invitation = new URLSearchParams(location.hash.slice(1)).get("room");
if (invitation) join(invitation);

if (!window.isSecureContext)
  $("network-label").textContent =
    "请使用 HTTPS 或 localhost 打开，以启用安全传输";
