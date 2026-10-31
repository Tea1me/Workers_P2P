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
  private mode: "disk" | "download" | "temporary";
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
    private temporary?: () => Promise<Sink>,
  ) {
    // Device / desktop-mode UA detection is unreliable. All small files use download first.
    this.mode = this.canDownload
      ? "download"
      : temporary
        ? "temporary"
        : picker
          ? "disk"
          : "download";
    this.render();
  }
  private get canDownload(): boolean {
    return this.meta.size <= MEMORY_LIMIT;
  }
  private render(): void {
    this.events.render({
      label: this.busy
        ? this.mode === "temporary"
          ? "正在准备接收…"
          : "正在打开保存窗口…"
        : "接收文件",
      disabled: this.busy || (this.mode === "download" && !this.canDownload),
      fallback:
        this.mode === "disk"
          ? this.canDownload || !!this.temporary
          : !!this.picker,
      alternateLabel:
        this.mode === "disk" ? "使用浏览器自动接收" : "直接保存到磁盘（可选）",
      hint:
        this.hint ||
        (this.mode === "temporary"
          ? "接收时自动写入本地临时文件，完成后点击「保存文件」。文件不上传服务器，请保持页面打开。"
          : this.mode === "disk"
            ? "选择保存位置后直接写入磁盘。也可以使用下方的浏览器自动接收方式。"
            : this.canDownload
              ? "接收完成后，点击传输记录中的「保存文件」。较大文件会自动写入本地临时存储，无需选择保存位置。"
              : "浏览器本地文件存储不可用。请检查是否禁用了站点存储或处于受限的隐私模式，更新浏览器后重试。"),
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
    if (!this.active) return Promise.resolve();
    ++this.attempt;
    this.busy = false;
    if (this.mode === "disk") {
      if (this.canDownload) this.download();
      else if (this.temporary) {
        this.mode = "temporary";
        return this.accept();
      }
    } else if (this.picker) {
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
      let sink: Sink;
      if (this.mode === "temporary") sink = await this.temporary!();
      else {
        // Invoke from the click stack to preserve user activation for the optional native picker.
        const handle = await this.picker!({
          suggestedName: safeName(this.meta.name),
        });
        if (!current()) return;
        sink = await handle.createWritable();
      }
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
          if (this.mode === "disk" && this.temporary) this.mode = "temporary";
          this.hint =
            "无法创建本地接收文件，请检查可用磁盘空间和站点存储权限，然后重试。";
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
