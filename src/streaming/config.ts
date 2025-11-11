/* eslint-disable @typescript-eslint/no-explicit-any */
export interface StreamingConfig {
  signalingUrl: string;
  stunServers: string[];
  // Timeout before falling back to HTTP for a segment (ms)
  segmentWeRtcTimeoutMs: number;
}

export const defaultStreamingConfig: StreamingConfig = {
  signalingUrl: (import.meta as any).env?.VITE_SIGNALING_WS_URL || 'ws://localhost:8083/ws/signaling',
  stunServers: [
    'stun:stun.l.google.com:19302',
    'stun:global.stun.twilio.com:3478'
  ],
  segmentWeRtcTimeoutMs: 250
};
