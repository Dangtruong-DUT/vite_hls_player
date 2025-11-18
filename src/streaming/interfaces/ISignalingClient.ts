/**
 * Signaling Client Interfaces
 * Applies Interface Segregation and Single Responsibility Principles
 */

import type {
  WhoHasReplyMessage,
  SignalingMessage,
} from '../types';

/**
 * WebSocket Connection Manager Interface (SRP - Connection lifecycle)
 */
export interface IWebSocketConnectionManager {
  /**
   * Connect to WebSocket server
   */
  connect(url: string): Promise<void>;

  /**
   * Disconnect from server
   */
  disconnect(): void;

  /**
   * Check if connected
   */
  isConnected(): boolean;

  /**
   * Send message to server
   */
  send(message: SignalingMessage): void;

  /**
   * Get connection state
   */
  getConnectionState(): 'connecting' | 'connected' | 'disconnected' | 'reconnecting';
}

/**
 * Reconnection Strategy Interface (Strategy Pattern)
 */
export interface IReconnectionStrategy {
  /**
   * Strategy name
   */
  readonly name: string;

  /**
   * Calculate next reconnection delay
   */
  getNextDelay(attemptCount: number): number;

  /**
   * Check if should attempt reconnection
   */
  shouldReconnect(attemptCount: number): boolean;

  /**
   * Reset strategy state
   */
  reset(): void;
}

/**
 * Message Handler Interface (SRP - Message handling)
 */
export interface ISignalingMessageHandler {
  /**
   * Handle incoming message
   */
  handleMessage(data: string): void;

  /**
   * Register message type handler
   */
  registerHandler<T extends SignalingMessage>(
    messageType: T['type'],
    handler: (message: T) => void
  ): void;

  /**
   * Unregister message type handler
   */
  unregisterHandler(messageType: string): void;
}

/**
 * Heartbeat Manager Interface (SRP - Connection keep-alive)
 */
export interface IHeartbeatManager {
  /**
   * Start heartbeat
   */
  start(interval: number): void;

  /**
   * Stop heartbeat
   */
  stop(): void;

  /**
   * Send heartbeat ping
   */
  ping(): void;

  /**
   * Handle heartbeat pong
   */
  pong(): void;

  /**
   * Check if heartbeat is active
   */
  isActive(): boolean;
}

/**
 * Query Request Manager Interface (SRP - Request/response tracking)
 */
export interface IQueryRequestManager {
  /**
   * Create pending request with timeout
   */
  createRequest<T>(
    requestId: string,
    timeout: number
  ): Promise<T>;

  /**
   * Resolve pending request
   */
  resolveRequest<T>(requestId: string, data: T): void;

  /**
   * Reject pending request
   */
  rejectRequest(requestId: string, error: Error): void;

  /**
   * Cancel request
   */
  cancelRequest(requestId: string): void;

  /**
   * Get pending request count
   */
  getPendingCount(): number;
}

/**
 * Segment Query Interface (SRP - Segment-related queries)
 */
export interface ISegmentQueryClient {
  /**
   * Query who has segment
   */
  whoHas(qualityId: string, segmentId: string): Promise<WhoHasReplyMessage>;

  /**
   * Report segment fetch
   */
  reportSegmentFetch(
    segmentId: string,
    qualityId: string,
    source?: 'peer' | 'server',
    latency?: number,
    speed?: number
  ): void;
}

/**
 * WebRTC Signaling Interface (SRP - WebRTC signaling)
 */
export interface IWebRTCSignalingClient {
  /**
   * Send WebRTC offer
   */
  sendOffer(peerId: string, offer: RTCSessionDescriptionInit): void;

  /**
   * Send WebRTC answer
   */
  sendAnswer(peerId: string, answer: RTCSessionDescriptionInit): void;

  /**
   * Send ICE candidate
   */
  sendIceCandidate(peerId: string, candidate: RTCIceCandidateInit): void;
}

/**
 * Seeder URL Provider Interface (SRP - URL generation)
 */
export interface ISeederUrlProvider {
  /**
   * Get seeder URL for segment
   */
  getSeederUrl(qualityId: string, segmentId: string): string;

  /**
   * Set seeder endpoint
   */
  setSeederEndpoint(endpoint: string): void;

  /**
   * Get base seeder endpoint
   */
  getSeederEndpoint(): string;
}

/**
 * Complete Signaling Client Interface
 */
export interface ISignalingClient
  extends IWebSocketConnectionManager,
    ISegmentQueryClient,
    IWebRTCSignalingClient,
    ISeederUrlProvider {
  /**
   * Get client ID
   */
  getClientId(): string;

  /**
   * Get movie ID
   */
  getMovieId(): string;

  /**
   * Set reconnection strategy
   */
  setReconnectionStrategy(strategy: IReconnectionStrategy): void;
}
