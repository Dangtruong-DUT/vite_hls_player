import type { PeerInfo, PeerScore, SegmentMetadata, FetchResult } from '../types';

export interface IPeerScoringStrategy {
  readonly name: string;
  calculateScore(peer: PeerInfo): number;
  onFetchSuccess(peer: PeerInfo, latency: number, size: number): void;
  onFetchFailure(peer: PeerInfo, error: Error): void;
}

export interface IPeerManager {
  connectToPeer(peerId: string): Promise<PeerInfo>;
  disconnectPeer(peerId: string): void;
  disconnectLowestScoredPeer(): void;
  getPeer(peerId: string): PeerInfo | undefined;
  getConnectedPeers(): PeerInfo[];
  getActivePeerCount(): number;
  isPeerConnected(peerId: string): boolean;
  fetchFromPeer(peer: PeerInfo, segment: SegmentMetadata): Promise<FetchResult>;
  updatePeerSegmentAvailability(peerId: string, segmentKeys: string[]): void;
  getBestPeersForSegment(segmentKey: string, maxPeers: number): PeerScore[];
  peerHasSegment(peerId: string, segmentKey: string): boolean;
  getPeersWithSegment(segmentKey: string): string[];
  setScoringStrategy(strategy: IPeerScoringStrategy): void;
  destroy(): void;
}
