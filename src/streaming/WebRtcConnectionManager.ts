/* eslint-disable @typescript-eslint/no-explicit-any */
import { FRAME_CHUNK, FRAME_DONE, FRAME_REQUEST, buildChunkFrame, buildDoneFrame, buildRequestFrame, parseFrame, DEFAULT_CHUNK_SIZE } from './chunkProtocol';
import SignalingClient from './SignalingClient';

type Listener = (...args: any[]) => void;

interface PeerRecord {
  pc: RTCPeerConnection;
  dc: RTCDataChannel | null;
  id: string;
}

export interface WebRtcManagerOptions {
  clientId: string;
  streamId: string;
  signaling: SignalingClient;
  stunServers?: string[];
  chunkSize?: number;
}

export default class WebRtcConnectionManager {
  private iceServers: RTCIceServer[];
  private peers = new Map<string, PeerRecord>();
  private chunkSize: number;
  private listeners = new Map<string, Set<Listener>>();
  private opts: WebRtcManagerOptions;

  constructor(opts: WebRtcManagerOptions) {
    this.opts = opts;
    this.chunkSize = opts.chunkSize || DEFAULT_CHUNK_SIZE;
    this.iceServers = (opts.stunServers || [
      'stun:stun.l.google.com:19302',
      'stun:global.stun.twilio.com:3478'
    ]).map((u) => ({ urls: u }));
    this.wireSignaling();
  }

  on(event: string, l: Listener) { if (!this.listeners.has(event)) this.listeners.set(event, new Set()); this.listeners.get(event)!.add(l); }
  off(event: string, l: Listener) { this.listeners.get(event)?.delete(l); }
  private emit(event: string, ...args: any[]) { this.listeners.get(event)?.forEach((l) => { try { l(...args); } catch { /* noop */ } }); }

  private wireSignaling() {
    const s = this.opts.signaling;
    s.on('peer_list', (msg: any) => {
      const peers: string[] = Array.isArray(msg.peers) ? msg.peers : [];
      peers.filter((p) => p !== this.opts.clientId).forEach((p) => this.ensureOffer(p));
    });
    s.on('RTC_OFFER', async (msg: any) => {
      const from = msg.from; if (!from || from === this.opts.clientId) return;
      const { pc } = this.ensurePeer(from, false);
      try {
        await pc.setRemoteDescription({ type: 'offer', sdp: msg.sdp });
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        this.opts.signaling.sendRtcAnswer(from, answer.sdp || '');
      } catch { /* noop */ }
    });
    s.on('RTC_ANSWER', async (msg: any) => {
      const from = msg.from; if (!from || from === this.opts.clientId) return;
      const peer = this.peers.get(from); if (!peer) return;
      try { await peer.pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp }); } catch { /* noop */ }
    });
    s.on('ICE_CANDIDATE', async (msg: any) => {
      const from = msg.from; if (!from || from === this.opts.clientId) return;
      const peer = this.peers.get(from); if (!peer) return;
      try { await peer.pc.addIceCandidate(msg.candidate); } catch { /* noop */ }
    });
  }

  private ensurePeer(remotePeerId: string, initiator: boolean): PeerRecord {
    if (this.peers.has(remotePeerId)) return this.peers.get(remotePeerId)!;
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    const rec: PeerRecord = { pc, dc: null, id: remotePeerId };
    this.peers.set(remotePeerId, rec);
    pc.onicecandidate = (ev) => { if (ev.candidate) this.opts.signaling.sendIceCandidate(remotePeerId, ev.candidate.toJSON()); };
    pc.onconnectionstatechange = () => {
      if (['failed', 'disconnected', 'closed'].includes(pc.connectionState)) {
        this.peers.delete(remotePeerId);
      }
    };
    pc.ondatachannel = (ev) => this.setupChannel(remotePeerId, ev.channel);
    if (initiator) this.setupChannel(remotePeerId, pc.createDataChannel('segments'));
    return rec;
  }

  private setupChannel(remotePeerId: string, channel: RTCDataChannel) {
    const rec = this.peers.get(remotePeerId); if (rec) rec.dc = channel;
    const assembly = new Map<string, { total: number; chunks: Uint8Array[]; received: number }>();
    channel.binaryType = 'arraybuffer';
    channel.onmessage = (ev) => {
      const data = ev.data;
      try {
        if (data instanceof ArrayBuffer || data instanceof Uint8Array) {
          const frame = parseFrame(data as any);
          if (frame.type === FRAME_CHUNK) {
            let st = assembly.get(frame.segmentId);
            if (!st) { st = { total: frame.total, chunks: new Array(frame.total), received: 0 }; assembly.set(frame.segmentId, st); }
            if (!st.chunks[frame.index]) { st.chunks[frame.index] = frame.payload; st.received += 1; }
            if (st.received === st.total) {
              const size = st.chunks.reduce((a, c) => a + c.length, 0);
              const full = new Uint8Array(size);
              let off = 0; for (const ch of st.chunks) { full.set(ch, off); off += ch.length; }
              assembly.delete(frame.segmentId);
              this.emit('segment', { from: remotePeerId, segmentId: frame.segmentId, data: full });
            }
          } else if (frame.type === FRAME_REQUEST) {
            this.emit('request', { from: remotePeerId, segmentId: frame.segmentId, channel });
          } else if (frame.type === FRAME_DONE) {
            /* optional */
          }
        } else if (typeof data === 'string') {
          try {
            const msg = JSON.parse(data);
            if (msg.type === 'SEGMENT_REQUEST' && msg.segmentId) {
              const f = buildRequestFrame(msg.segmentId);
              (channel as any).send(f);
            }
          } catch { /* noop */ }
        }
      } catch { /* noop */ }
    };
  }

  async ensureOffer(remotePeerId: string) {
    const { pc } = this.ensurePeer(remotePeerId, true);
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this.opts.signaling.sendRtcOffer(remotePeerId, offer.sdp || '');
    } catch { /* noop */ }
  }

  requestSegment(segmentId: string) {
    for (const [, rec] of this.peers) {
      const dc = rec.dc;
      if (dc && dc.readyState === 'open') {
        try { const f = buildRequestFrame(segmentId); (dc as any).send(f); } catch { /* noop */ }
      }
    }
  }

  sendSegment(channel: RTCDataChannel, segmentId: string, data: Uint8Array) {
    const total = Math.ceil(data.length / this.chunkSize);
    for (let i = 0; i < total; i++) {
      const start = i * this.chunkSize;
      const end = Math.min(data.length, start + this.chunkSize);
      const slice = data.subarray(start, end);
      try { const frame = buildChunkFrame(segmentId, i, total, slice); (channel as any).send(frame); } catch { break; }
    }
    try { const done = buildDoneFrame(segmentId); (channel as any).send(done); } catch { /* noop */ }
  }
}
