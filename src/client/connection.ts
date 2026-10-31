import { PROTOCOL, ROOM_PATTERN } from "../shared/protocol";
export type ConnectionState =
  | "offline"
  | "joining"
  | "waiting"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "failed";
export interface ConnectionEvents {
  state: (state: ConnectionState, detail?: string) => void;
  peer: (name: string) => void;
  message: (data: string | ArrayBuffer) => void;
  ready: () => void;
  lost: () => void;
  route: (text: string) => void;
}
export class Connection {
  private ws?: WebSocket;
  private pc?: RTCPeerConnection;
  private channel?: RTCDataChannel;
  private stopped = true;
  private retry = 0;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private connectTimer?: ReturnType<typeof setTimeout>;
  private disconnectTimer?: ReturnType<typeof setTimeout>;
  private lastPong = 0;
  private generation = 0;
  private candidates: RTCIceCandidateInit[] = [];
  private signalChain: Promise<void> = Promise.resolve();
  private id = "";

  private initiator = false;
  private session = "";
  private restartAttempts = 0;
  private room = "";
  private name = "";
  constructor(private events: ConnectionEvents) {}
  get open(): boolean {
    return this.channel?.readyState === "open";
  }
  get bufferedAmount(): number {
    return this.channel?.bufferedAmount ?? 0;
  }
  join(room: string, name: string): void {
    if (!ROOM_PATTERN.test(room)) throw new Error("房间码格式不正确");
    if (!this.id) this.id = crypto.randomUUID();
    this.leave();
    this.room = room;
    this.name = name;
    this.stopped = false;
    this.retry = 0;
    this.connect();
  }
  private connect(): void {
    const generation = ++this.generation;
    this.events.state(this.retry ? "reconnecting" : "joining");
    const url = new URL(`/api/room/${this.room}`, location.href);
    url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("id", this.id);
    url.searchParams.set("name", this.name);
    url.searchParams.set("ready", this.open ? "1" : "0");
    const ws = (this.ws = new WebSocket(url));
    const isCurrent = () => generation === this.generation && !this.stopped;
    ws.onopen = () => {
      if (!isCurrent()) return;
      this.lastPong = Date.now();
      this.heartbeat = setInterval(() => {
        if (Date.now() - this.lastPong > 60000) {
          ws.close();
          return;
        }
        if (ws.readyState === WebSocket.OPEN) ws.send("ping");
      }, 20000);
    };
    ws.onmessage = (event) => {
      if (!isCurrent()) return;
      if (event.data === "pong") {
        this.lastPong = Date.now();
        return;
      }
      this.signalChain = this.signalChain
        .then(async () => {
          if (!isCurrent()) return;
          const m = JSON.parse(String(event.data));
          if (m.type === "welcome") {
            if (m.protocol !== PROTOCOL) {
              this.leave();
              this.events.state("failed", "版本已更新，请刷新页面");
              return;
            }
            this.retry = 0;
            if (!this.open) this.events.state("waiting");
          } else if (m.type === "paired") {
            this.events.peer(String(m.peer.name));
            if (this.session === m.session) return;
            this.initiator = m.initiator === this.id;
            this.session = m.session;
            if (m.negotiate === false && this.open) {
              this.status(true);
              return;
            }
            await this.createPeer(this.initiator);
          } else if (m.type === "error") {
            clearInterval(this.heartbeat);
            this.stopped = true;
            if (!this.open) this.failPeer(String(m.message));
            ws.close();
          } else if (m.type === "peer-left") {
            if (!this.open) {
              this.closePeer();
              this.events.state("waiting", "对方已离开，等待重新加入");
            }
          } else if (m.type === "signal" && m.session === this.session)
            await this.handleSignal(m.data);
        })
        .catch((error: Error) => {
          if (isCurrent())
            this.failPeer(
              `连接协商失败：${error.message || error.name}。请两端刷新后重新连接`,
            );
        });
    };
    ws.onclose = (event) => {
      if (!isCurrent()) return;
      clearInterval(this.heartbeat);
      if ([4001, 4002, 4004, 1008, 1009].includes(event.code)) {
        this.stopped = true;
        if (!this.open)
          this.events.state(
            "failed",
            event.code === 4002
              ? "房间已过期，请创建新房间"
              : "连接被关闭，请重新加入",
          );
        return;
      }
      if (!this.open)
        this.events.state("reconnecting", "信令连接中断，正在重试…");
      if (++this.retry > 8) {
        if (!this.open)
          this.events.state("failed", "无法加入：请检查网络，或确认房间未满");
        return;
      }
      this.retryTimer = setTimeout(
        () => this.connect(),
        Math.min(1000 * 2 ** (this.retry - 1), 15000) + Math.random() * 500,
      );
    };
    ws.onerror = () => {
      /* onclose owns retries, including failed HTTP upgrades */
    };
  }
  private signal(data: unknown): void {
    if (this.ws?.readyState !== WebSocket.OPEN)
      throw new Error("配对服务暂不可用");
    this.ws.send(
      JSON.stringify({ type: "signal", session: this.session, data }),
    );
  }
  private status(open: boolean): void {
    if (this.session && this.ws?.readyState === WebSocket.OPEN)
      this.ws.send(
        JSON.stringify({ type: "status", session: this.session, open }),
      );
  }
  private async createPeer(initiator: boolean): Promise<void> {
    this.closePeer();
    this.events.state("connecting");
    this.restartAttempts = 0;
    const pc = (this.pc = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }],
      iceCandidatePoolSize: 0,
    }));
    this.candidates = [];
    pc.onicecandidate = (event) => {
      if (this.pc === pc && event.candidate) {
        try {
          this.signal({
            kind: "candidate",
            candidate: {
              candidate: event.candidate.candidate,
              sdpMid: event.candidate.sdpMid,
              sdpMLineIndex: event.candidate.sdpMLineIndex,
              usernameFragment: event.candidate.usernameFragment,
            },
          });
        } catch {
          /* reconnect will renegotiate */
        }
      }
    };
    pc.onconnectionstatechange = () => {
      if (this.pc !== pc) return;
      if (pc.connectionState === "connected") {
        clearTimeout(this.disconnectTimer);
        if (this.open) this.events.state("connected");
      }
      if (pc.connectionState === "failed") {
        if (this.restartAttempts)
          this.failPeer(
            "无法直连，请确认手机使用 Wi-Fi、双方关闭 VPN，且路由器没有访客隔离",
          );
        else if (this.initiator)
          void this.restart(pc).catch(() =>
            this.failPeer("网络重试失败，请重新连接"),
          );
        else {
          this.restartAttempts = 1;
          this.events.state("reconnecting", "正在重新探测设备连接…");
          try {
            this.signal({ kind: "restart" });
          } catch {
            this.failPeer("配对服务不可用，请重新连接");
          }
          clearTimeout(this.connectTimer);
          this.connectTimer = setTimeout(() => {
            if (this.pc === pc && !this.open)
              this.failPeer("重试后仍无法直连，请检查 Wi-Fi 隔离或 VPN");
          }, 20000);
        }
      }
      if (pc.connectionState === "disconnected") {
        this.events.state("reconnecting", "设备连接中断，正在等待网络恢复…");
        clearTimeout(this.disconnectTimer);
        this.disconnectTimer = setTimeout(() => {
          if (this.pc === pc && pc.connectionState === "disconnected")
            this.failPeer("连接中断。重新连接后可继续未完成的文件");
        }, 12000);
      }
    };
    pc.ondatachannel = (event) => this.bindChannel(event.channel, pc);
    this.connectTimer = setTimeout(() => {
      if (this.pc === pc && !this.open)
        this.failPeer(
          "直连超时。请确认同一 Wi-Fi 未启用访客隔离，并点击重新连接",
        );
    }, 30000);
    if (initiator) {
      this.bindChannel(pc.createDataChannel("files-v1", { ordered: true }), pc);
      await pc.setLocalDescription(await pc.createOffer());
      if (this.pc === pc)
        this.signal({
          kind: "description",
          type: pc.localDescription!.type,
          sdp: pc.localDescription!.sdp,
        });
    }
  }
  private async handleSignal(data: Record<string, unknown>): Promise<void> {
    const pc = this.pc;
    if (!pc) return;
    if (data.kind === "restart") {
      if (this.initiator) await this.restart(pc);
      return;
    }
    if (data.kind === "description") {
      await pc.setRemoteDescription({
        type: data.type as RTCSdpType,
        sdp: data.sdp as string,
      });
      if (this.pc !== pc) return;
      for (const candidate of this.candidates.splice(0))
        await pc.addIceCandidate(candidate);
      if (data.type === "offer") {
        await pc.setLocalDescription(await pc.createAnswer());
        if (this.pc === pc)
          this.signal({
            kind: "description",
            type: "answer",
            sdp: pc.localDescription!.sdp,
          });
      }
    } else if (data.kind === "candidate" && data.candidate) {
      if (pc.remoteDescription)
        await pc.addIceCandidate(data.candidate as RTCIceCandidateInit);
      else this.candidates.push(data.candidate as RTCIceCandidateInit);
    }
  }
  private async restart(pc: RTCPeerConnection): Promise<void> {
    if (this.pc !== pc || this.restartAttempts) return;
    this.restartAttempts = 1;
    this.events.state("reconnecting", "正在重新探测设备连接…");
    pc.restartIce();
    await pc.setLocalDescription(await pc.createOffer({ iceRestart: true }));
    if (this.pc !== pc) return;
    this.signal({
      kind: "description",
      type: "offer",
      sdp: pc.localDescription!.sdp,
    });
    clearTimeout(this.connectTimer);
    this.connectTimer = setTimeout(() => {
      if (this.pc === pc && pc.connectionState !== "connected")
        this.failPeer("重试后仍无法直连，请检查 Wi-Fi 隔离或 VPN");
    }, 20000);
  }
  private bindChannel(channel: RTCDataChannel, pc: RTCPeerConnection): void {
    this.channel = channel;
    channel.binaryType = "arraybuffer";
    channel.bufferedAmountLowThreshold = 256 * 1024;
    channel.onopen = () => {
      if (this.pc !== pc) return;
      clearTimeout(this.connectTimer);
      this.status(true);
      this.events.state("connected");
      this.events.ready();
      void this.route(pc);
    };
    channel.onmessage = (event) => {
      if (this.pc === pc) this.events.message(event.data);
    };
    channel.onclose = () => {
      if (this.pc === pc) this.failPeer("直连已断开，点击重新连接可继续传输");
    };
    channel.onerror = () => {
      if (this.pc === pc) this.failPeer("数据通道发生错误，请重新连接");
    };
  }
  private async route(pc: RTCPeerConnection): Promise<void> {
    try {
      const stats = await pc.getStats();
      stats.forEach((s) => {
        if (
          s.type === "candidate-pair" &&
          s.state === "succeeded" &&
          s.nominated
        ) {
          const local = stats.get(s.localCandidateId);
          this.events.route(
            local?.protocol === "udp" ? "设备直连 · UDP" : "设备直连",
          );
        }
      });
    } catch {
      this.events.route("设备直连");
    }
  }
  send(data: string | ArrayBuffer): void {
    if (!this.open) throw new Error("设备尚未连接");
    if (typeof data === "string") this.channel!.send(data);
    else {
      const limit = Math.min(
        64 * 1024,
        this.pc?.sctp?.maxMessageSize || 64 * 1024,
      );
      if (data.byteLength <= limit) this.channel!.send(data);
      else
        for (let offset = 0; offset < data.byteLength; offset += limit)
          this.channel!.send(data.slice(offset, offset + limit));
    }
  }
  async drain(): Promise<void> {
    const channel = this.channel;
    if (!channel || channel.readyState !== "open")
      throw new Error("连接已断开");
    if (channel.bufferedAmount <= 1024 * 1024) return;
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        channel.removeEventListener("bufferedamountlow", low);
        channel.removeEventListener("close", closed);
      };
      const low = () => {
        cleanup();
        resolve();
      };
      const closed = () => {
        cleanup();
        reject(new Error("连接已断开"));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("传输缓冲区超时"));
      }, 30000);
      channel.addEventListener("bufferedamountlow", low);
      channel.addEventListener("close", closed);
      if (channel.bufferedAmount <= channel.bufferedAmountLowThreshold) low();
    });
  }
  private failPeer(detail: string): void {
    this.closePeer();
    this.events.state("failed", detail);
  }
  private closePeer(): void {
    clearTimeout(this.connectTimer);
    clearTimeout(this.disconnectTimer);
    const hadPeer = !!this.pc;
    if (hadPeer) this.status(false);
    const pc = this.pc;
    this.pc = undefined;
    this.channel?.close();
    this.channel = undefined;
    pc?.close();
    this.candidates = [];
    if (hadPeer) this.events.lost();
  }
  reconnect(): void {
    const room = this.room,
      name = this.name;
    this.join(room, name);
  }
  leave(): void {
    this.stopped = true;
    ++this.generation;
    clearTimeout(this.retryTimer);
    clearInterval(this.heartbeat);
    this.ws?.close();
    this.ws = undefined;
    this.closePeer();
    this.signalChain = Promise.resolve();
    this.session = "";
    this.events.state("offline");
  }
}
