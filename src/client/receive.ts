import { MEMORY_LIMIT, type Metadata, type Sink } from "./transfer";
import { safeName } from "./format";

export type SavePicker = (options: {
  suggestedName: string;
}) => Promise<{ createWritable(): Promise<Sink> }>;
export interface ReceiveView {
  label: string;
  disabled: boolean;
  fallback: boolean;
  hint: string;
  error: boolean;
}
export function isMobileDevice(device: {
  userAgent: string;
  maxTouchPoints: number;
  userAgentData?: { mobile?: boolean };
}): boolean {
  return (
    device.userAgentData?.mobile === true ||
    /Android|iPhone|iPad|iPod/i.test(device.userAgent) ||
    (/Macintosh/.test(device.userAgent) && device.maxTouchPoints > 1)
  );
}

/** Keep picker failures and pending native dialogs from trapping the receive flow. */
export class ReceiveController {
  private mode: "disk" | "download";
  private active = true;
  private busy = false;
  private attempt = 0;
  private hint = "";
  private error = false;
  constructor(
    private meta: Pick<Metadata, "name" | "size">,
    mobile: boolean,
    private picker: SavePicker | undefined,
    private events: {
      render(view: ReceiveView): void;
      accept(result: { sink?: Sink }): void;
    },
  ) {
    // Mobile browsers can expose the API even when the system picker fails.
    // Keep working Android large-file support, but prefer the simpler download path for small files.
    this.mode = picker && (!mobile || !this.canDownload) ? "disk" : "download";
    this.render();
  }
  private get canDownload(): boolean {
    return this.meta.size <= MEMORY_LIMIT;
  }
  private render(): void {
    this.events.render({
      label: this.busy
        ? "正在打开保存位置…"
        : this.mode === "disk"
          ? "选择位置并接收"
          : "接收并下载",
      disabled: this.busy || (this.mode === "download" && !this.canDownload),
      fallback: this.mode === "disk" && this.canDownload,
      hint:
        this.hint ||
        (this.mode === "disk"
          ? "选择保存位置后直接写入磁盘。如果系统选择器没有响应，128 MiB 以内的文件可改用下方下载接收。"
          : this.canDownload
            ? "接收完成后，点击传输记录中的「保存文件」。无需选择保存位置，单文件上限 128 MiB。"
            : "此浏览器无法直接保存大文件，内存接收上限为 128 MiB。请换用支持文件保存接口的浏览器，或在电脑上接收。"),
      error: this.error || (this.mode === "download" && !this.canDownload),
    });
  }
  private finish(result: { sink?: Sink }): void {
    if (!this.active) return;
    this.active = false;
    this.busy = false;
    ++this.attempt;
    this.events.accept(result);
  }
  download(): void {
    if (this.active && this.canDownload) this.finish({});
  }
  async accept(): Promise<void> {
    if (!this.active || this.busy) return;
    if (this.mode === "download") {
      this.download();
      return;
    }
    const attempt = ++this.attempt;
    const current = () => this.active && this.attempt === attempt;
    this.busy = true;
    this.hint = "";
    this.error = false;
    this.render();
    try {
      // Invoke directly from the click handler, before awaiting anything: preserve user activation.
      const handle = await this.picker!({
        suggestedName: safeName(this.meta.name),
      });
      if (!current()) return;
      const sink = await handle.createWritable();
      if (!current()) {
        try {
          await sink.abort();
        } catch {
          /* cancelled late result */
        }
        return;
      }
      this.finish({ sink });
    } catch (error) {
      if (!current()) return;
      if ((error as Error).name === "AbortError") {
        this.hint = this.canDownload
          ? "已取消选择保存位置。可以重新选择，或使用下方的下载接收。"
          : "已取消选择保存位置。点击按钮可以重新选择。";
      } else {
        this.error = true;
        if (this.canDownload) {
          this.mode = "download";
          this.hint =
            "浏览器未能打开保存位置，已切换为下载接收。点击「接收并下载」即可继续，完成后点击「保存文件」。";
        } else {
          this.hint =
            "浏览器未能创建保存文件。请重试并确认存储权限；大于 128 MiB 的文件也可换用支持文件保存接口的浏览器，或在电脑上接收。";
        }
      }
    } finally {
      if (current()) {
        this.busy = false;
        this.render();
      }
    }
  }
  close(): void {
    this.active = false;
    this.busy = false;
    ++this.attempt;
  }
}
