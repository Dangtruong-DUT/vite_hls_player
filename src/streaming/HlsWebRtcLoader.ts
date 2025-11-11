/* eslint-disable @typescript-eslint/no-explicit-any */
import SignalingClient from './SignalingClient';
import WebRtcConnectionManager from './WebRtcConnectionManager';
import { defaultStreamingConfig } from './config';

type OnSuccess = (response: { data: ArrayBuffer }, stats: any, context: any) => void;
type OnError = (error: { code: number; text: string }, context: any, networkDetails: any, stats: any) => void;
type OnTimeout = (stats: any, context: any, networkDetails: any) => void;

interface Callbacks { onSuccess: OnSuccess; onError: OnError; onTimeout: OnTimeout }

const segmentCache = new Map<string, Uint8Array>();
const pending = new Map<string, Array<(data: Uint8Array) => void>>();

function extractSegmentId(url: string): string | null {
  try {
    const withoutQuery = url.split('?')[0];
    const file = withoutQuery.split('/').pop();
    if (!file) return null;
    const dot = file.indexOf('.');
    return dot > 0 ? file.slice(0, dot) : file;
  } catch { return null; }
}

function now() { return performance.now(); }

export default class HlsWebRtcLoader {
  // Hls.js will new this for every load; we want shared state
  static singleton: HlsWebRtcLoader | null = null;
  static ensure(signalingUrl: string, clientId: string, streamId: string) {
    if (HlsWebRtcLoader.singleton) return HlsWebRtcLoader.singleton;
    HlsWebRtcLoader.singleton = new HlsWebRtcLoader(signalingUrl, clientId, streamId);
    return HlsWebRtcLoader.singleton;
  }

  private signaling: SignalingClient;
  private webrtc: WebRtcConnectionManager;
  // private closed = false; // reserved for future

  constructor(signalingUrl: string, clientId: string, streamId: string) {
    this.signaling = new SignalingClient({ url: signalingUrl, clientId, streamId });
    this.webrtc = new WebRtcConnectionManager({ clientId, streamId, signaling: this.signaling, stunServers: defaultStreamingConfig.stunServers });
    this.wire();
    // connect but don't await to not block player start
    this.signaling.connect().catch(() => void 0);
  }

  private wire() {
    this.webrtc.on('segment', ({ segmentId, data }) => {
      segmentCache.set(segmentId, data);
      const waiters = pending.get(segmentId);
      if (waiters && waiters.length) {
        pending.delete(segmentId);
        for (const fn of waiters) { try { fn(data); } catch { /* noop */ } }
      }
    });
    this.webrtc.on('request', ({ segmentId, channel }) => {
      const cached = segmentCache.get(segmentId);
      if (cached && channel?.readyState === 'open') {
        this.webrtc.sendSegment(channel, segmentId, cached);
      }
    });
  }

  // Hls.js interface
  context: any;
  stats: any = { trequest: 0, tfirst: 0, tload: 0, loaded: 0, total: 0 }; // minimal
  config: any;

  constructorInternal(config: any) { this.config = config; }

  load(context: any, _config: any, callbacks: Callbacks) {
    this.context = context;
    const url: string = context?.url ?? '';
    const segId = extractSegmentId(url);
    const start = now();
    this.stats.trequest = start;

    const complete = (data: ArrayBuffer) => {
      const end = now();
      this.stats.tfirst = end;
      this.stats.tload = end;
      this.stats.loaded = data.byteLength;
      this.stats.total = data.byteLength;
      callbacks.onSuccess({ data }, this.stats, context);
    };

    // Non-fragment or no segment id: do normal fetch
    if (context?.type !== 'fragment' || !segId) {
      fetch(url)
        .then((r) => r.arrayBuffer())
        .then(complete)
        .catch((e) => callbacks.onError({ code: 0, text: e?.message || 'fetch fail' }, context, null, this.stats));
      return;
    }

    // Try cache first
    const cached = segmentCache.get(segId);
  if (cached) { const ab = cached.slice().buffer; complete(ab as ArrayBuffer); return; }

    // Ask peers via WebRTC
    this.webrtc.requestSegment(segId);
    let resolved = false;
    const timer = setTimeout(() => {
      if (resolved) return;
      // Fallback to HTTP with original HLS URL
      fetch(url)
        .then((r) => r.arrayBuffer())
  .then((ab) => { resolved = true; complete(ab as ArrayBuffer); })
        .catch((e) => callbacks.onError({ code: 0, text: e?.message || 'fetch fail' }, context, null, this.stats));
    }, defaultStreamingConfig.segmentWeRtcTimeoutMs);

    // Wait for DC
    const list = pending.get(segId) || [];
    list.push((data) => {
      if (resolved) return;
      clearTimeout(timer);
      resolved = true;
      // copy to ArrayBuffer
  const ab = data.slice().buffer as ArrayBuffer;
  complete(ab);
    });
    pending.set(segId, list);
  }

  abort() { /* noop */ }
  destroy() { /* noop */ }
}
