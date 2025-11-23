import type {
  WhoHasReplyMessage,
  SignalingMessage,
} from '../types';

export interface ISignalingClient {
  connect(url: string): Promise<void>;
  disconnect(): void;
  isConnected(): boolean;
  send(message: SignalingMessage): void;
  getConnectionState(): 'connecting' | 'connected' | 'disconnected' | 'reconnecting';
  whoHas(qualityId: string, segmentId: string): Promise<WhoHasReplyMessage>;
  reportSegmentFetch(
    segmentId: string,
    qualityId: string,
    source?: 'peer' | 'server',
    latency?: number,
    speed?: number
  ): void;
  reportSegmentRemoval(
    segmentId: string,
    qualityId: string
  ): void;
  sendOffer(peerId: string, offer: RTCSessionDescriptionInit): void;
  sendAnswer(peerId: string, answer: RTCSessionDescriptionInit): void;
  sendIceCandidate(peerId: string, candidate: RTCIceCandidateInit): void;
  getSeederUrl(qualityId: string, segmentId: string): string;
  getClientId(): string;
  getMovieId(): string;
}
