/* eslint-disable @typescript-eslint/no-explicit-any */
type Listener = (...args: any[]) => void;

export type SignalingEvents =
  | 'open'
  | 'close'
  | 'error'
  | 'message'
  | 'peer_list'
  | 'RTC_OFFER'
  | 'RTC_ANSWER'
  | 'ICE_CANDIDATE';

export interface SignalingOptions {
  url: string;
  clientId: string;
  streamId: string;
}

export default class SignalingClient {
  private socket: WebSocket | null = null;
  private listeners = new Map<SignalingEvents, Set<Listener>>();
  private pendingWhoHas = new Map<string, { resolve: (peers: any[]) => void; reject: (e: any) => void; timer: any }>();
  private connected = false;
  private opts: SignalingOptions;

  constructor(opts: SignalingOptions) { this.opts = opts; }

  async connect(): Promise<void> {
    if (this.connected) return;
    const url = `${this.opts.url}?clientId=${encodeURIComponent(this.opts.clientId)}&streamId=${encodeURIComponent(this.opts.streamId)}`;
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url);
      let settled = false;
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => {
        this.socket = ws;
        this.connected = true;
        settled = true;
        this.emit('open');
        resolve();
      };
      ws.onerror = (ev) => {
        if (!settled) { settled = true; reject(new Error('Signaling error')); }
        this.emit('error', ev);
      };
      ws.onclose = () => {
        this.connected = false;
        this.socket = null;
        this.cleanupPending(new Error('Signaling closed'));
        this.emit('close');
      };
      ws.onmessage = (ev) => this.handleMessage(ev.data);
    });
  }

  on(event: SignalingEvents, listener: Listener): void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(listener);
  }

  off(event: SignalingEvents, listener: Listener): void {
    this.listeners.get(event)?.delete(listener);
  }

  emit(event: SignalingEvents, ...args: any[]): void {
    this.listeners.get(event)?.forEach((l) => {
      try { l(...args); } catch { /* noop */ }
    });
  }

  private handleMessage(raw: any) {
    let msg: any = raw;
    if (typeof raw === 'string') {
      try { msg = JSON.parse(raw); } catch { return; }
    }
    if (!msg || typeof msg !== 'object') return;
    const { type } = msg;
    if (!type) return;
    if (type === 'WHO_HAS_REPLY') {
      const segId = msg.segmentId;
      const pending = segId ? this.pendingWhoHas.get(segId) : null;
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingWhoHas.delete(segId);
        pending.resolve(Array.isArray(msg.peers) ? msg.peers : []);
      }
      return;
    }
    const forward: SignalingEvents[] = ['peer_list', 'RTC_OFFER', 'RTC_ANSWER', 'ICE_CANDIDATE'];
    if (forward.includes(type)) {
      this.emit(type as SignalingEvents, msg);
    } else {
      this.emit('message', msg);
    }
  }

  async requestWhoHas(segmentId: string, timeoutMs = 200): Promise<any[]> {
    if (!this.socket || !this.connected) return [];
    if (this.pendingWhoHas.has(segmentId)) {
      // @ts-expect-error - attach dynamic promise property
      return this.pendingWhoHas.get(segmentId)!.promise;
    }
    const payload = { type: 'WHO_HAS', streamId: this.opts.streamId, segmentId };
    const promise = new Promise<any[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingWhoHas.delete(segmentId);
        resolve([]);
      }, timeoutMs);
      this.pendingWhoHas.set(segmentId, { resolve, reject, timer });
      try { this.socket!.send(JSON.stringify(payload)); } catch (e) { clearTimeout(timer); this.pendingWhoHas.delete(segmentId); reject(e); }
    });
  // @ts-expect-error - attach dynamic promise property
    this.pendingWhoHas.get(segmentId)!.promise = promise;
    return promise;
  }

  send(obj: any) {
    if (!this.socket || !this.connected) return;
    try { this.socket.send(JSON.stringify(obj)); } catch { /* noop */ }
  }

  sendRtcOffer(to: string, sdp: string) { this.send({ type: 'RTC_OFFER', from: this.opts.clientId, to, streamId: this.opts.streamId, sdp }); }
  sendRtcAnswer(to: string, sdp: string) { this.send({ type: 'RTC_ANSWER', from: this.opts.clientId, to, streamId: this.opts.streamId, sdp }); }
  sendIceCandidate(to: string, candidate: RTCIceCandidateInit) { this.send({ type: 'ICE_CANDIDATE', from: this.opts.clientId, to, streamId: this.opts.streamId, candidate }); }

  reportSegment(segmentId: string, source: string, latencyMs?: number, speedMbps?: number) {
    this.send({ type: 'REPORT_SEGMENT', streamId: this.opts.streamId, segmentId, source, latency: Math.round(latencyMs || 0), speed: Number.isFinite(speedMbps || 0) ? Number((speedMbps || 0).toFixed?.(3) ?? 0) : 0 });
  }

  async close() { try { this.socket?.close(); } catch { /* noop */ } this.connected = false; }

  private cleanupPending(error: any) {
    for (const [, p] of this.pendingWhoHas) { clearTimeout(p.timer); try { p.reject(error); } catch { /* noop */ } }
    this.pendingWhoHas.clear();
  }
}
