/**
 * Peer Management Interfaces
 * Applies Interface Segregation and Dependency Inversion Principles
 */

import type { PeerInfo, PeerScore, SegmentMetadata, FetchResult } from '../types';

/**
 * Peer Scoring Strategy Interface (Strategy Pattern)
 */
export interface IPeerScoringStrategy {
  /**
   * Strategy name
   */
  readonly name: string;

  /**
   * Calculate score for a peer
   */
  calculateScore(peer: PeerInfo): number;

  /**
   * Update score after successful fetch
   */
  onFetchSuccess(peer: PeerInfo, latency: number, size: number): void;

  /**
   * Update score after failed fetch
   */
  onFetchFailure(peer: PeerInfo, error: Error): void;
}

/**
 * Peer Connection Manager Interface (SRP - Connection lifecycle)
 */
export interface IPeerConnectionManager {
  /**
   * Connect to peer
   */
  connectToPeer(peerId: string): Promise<PeerInfo>;

  /**
   * Disconnect from peer
   */
  disconnectPeer(peerId: string): void;

  /**
   * Disconnect lowest scored peer
   */
  disconnectLowestScoredPeer(): void;

  /**
   * Get peer info
   */
  getPeer(peerId: string): PeerInfo | undefined;

  /**
   * Get all connected peers
   */
  getConnectedPeers(): PeerInfo[];

  /**
   * Get active peer count
   */
  getActivePeerCount(): number;

  /**
   * Check if peer is connected
   */
  isPeerConnected(peerId: string): boolean;
}

/**
 * Data Channel Handler Interface (SRP - Data channel operations)
 */
export interface IDataChannelHandler {
  /**
   * Setup data channel event handlers
   */
  setupDataChannel(peer: PeerInfo): void;

  /**
   * Send segment request via data channel
   */
  sendSegmentRequest(peer: PeerInfo, segment: SegmentMetadata): Promise<ArrayBuffer>;

  /**
   * Handle incoming segment data
   */
  handleIncomingData(peerId: string, data: ArrayBuffer | string): void;

  /**
   * Cancel pending request
   */
  cancelRequest(requestId: string): void;
}

/**
 * WebRTC Signaling Handler Interface (SRP - WebRTC signaling)
 */
export interface IWebRTCSignalingHandler {
  /**
   * Handle peer offer
   */
  handlePeerOffer(peerId: string, offer: RTCSessionDescriptionInit): Promise<void>;

  /**
   * Handle peer answer
   */
  handlePeerAnswer(peerId: string, answer: RTCSessionDescriptionInit): Promise<void>;

  /**
   * Handle ICE candidate
   */
  handleIceCandidate(peerId: string, candidate: RTCIceCandidateInit): Promise<void>;

  /**
   * Create and send offer
   */
  createOffer(peer: PeerInfo): Promise<void>;

  /**
   * Create and send answer
   */
  createAnswer(peer: PeerInfo, offer: RTCSessionDescriptionInit): Promise<void>;
}

/**
 * Peer Segment Availability Tracker Interface (SRP - Segment tracking)
 */
export interface IPeerSegmentTracker {
  /**
   * Update peer's available segments
   */
  updatePeerSegmentAvailability(peerId: string, segmentKeys: string[]): void;

  /**
   * Get best peers for a segment
   */
  getBestPeersForSegment(segmentKey: string, maxPeers: number): PeerScore[];

  /**
   * Check if peer has segment
   */
  peerHasSegment(peerId: string, segmentKey: string): boolean;

  /**
   * Get peers with segment
   */
  getPeersWithSegment(segmentKey: string): string[];
}

/**
 * Complete Peer Manager Interface
 */
export interface IPeerManager
  extends IPeerConnectionManager,
    IPeerSegmentTracker {
  /**
   * Fetch segment from peer
   */
  fetchFromPeer(peer: PeerInfo, segment: SegmentMetadata): Promise<FetchResult>;

  /**
   * Set peer scoring strategy
   */
  setScoringStrategy(strategy: IPeerScoringStrategy): void;

  /**
   * Clean up all resources
   */
  destroy(): void;
}
