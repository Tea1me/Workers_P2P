import { MEMORY_LIMIT, type Metadata, type Sink } from "./transfer";
import { safeName } from "./format";

export type SavePicker = (options: {
  suggestedName: string;
}) => Promise<{ createWritable(): Promise<Sink> }>;
export interface ReceiveView {
  label: string;
  disabled: boolean;
  fallback: boolean;
  alternateLabel: string;
  hint: string;
  error: boolean;
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
    private picker: SavePicker | undefined,
    private events: {
      render(view: ReceiveView): void;
      accept(result: { sink?: Sink }): void;
    },
  ) {
    // Device / desktop-mode UA detection is unreliable. All small files use download first.
    this.mode = this.canDownload || !picker ? "download" : "disk";
    this.render();
  }
  private get canDownload(): boolean {
    return this.meta.size <= MEMORY_LIMIT;
  }
  private render(): void {
    this.events.render({
      label: this.busy ? "正在打开保存窗口…" : "接收文件",
      disabled: this.busy || (this.mode === "download" && !this.canDownload),
      fallback: !!this.picker && this.canDownload,
      alternateLabel:
        this.mode === "disk" ? "改用普通下载接收" : "直接保存到磁盘（可选）",
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
  alternate(): Promise<void> {
    if (this.mode === "disk") this.download();
    else if (this.active && !this.busy && this.picker) {
      this.mode = "disk";
      return this.accept();
    }
    return Promise.resolve();
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
            "浏览器未能打开保存窗口。点击「接收文件」即可普通下载，完成后点击「保存文件」。";
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
