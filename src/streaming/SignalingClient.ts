/**
 * SignalingClient
 * 
 * WebSocket signaling client theo Streaming Signaling Protocol v1.0.0
 * - whoHas: Tìm peer có segment
 * - reportSegment: Báo cáo đã tải segment với metrics
 * - WebRTC signaling: rtcOffer, rtcAnswer, iceCandidate
 * - Nhận peerList, whoHasReply, reportAck từ server
 */

import type { 
  WhoHasRequest,
  WhoHasReplyMessage,
  PeerListMessage,
  ReportAckMessage,
  ReportSegmentRequest,
  RtcOfferRequest,
  RtcOfferMessage,
  RtcAnswerRequest,
  RtcAnswerMessage,
  IceCandidateRequest,
  IceCandidateMessage,
  ErrorMessage
} from './types';
import { ConfigManager } from './ConfigManager';
import { EventEmitter } from './interfaces/IEventEmitter';
import type { ISignalingClient } from './interfaces/ISignalingClient';

export interface SignalingClientEvents {
  connected: () => void;
  disconnected: () => void;
  error: (error: Error) => void;
  whoHasReply: (response: WhoHasReplyMessage) => void;
  peerList: (data: PeerListMessage) => void;
  reportAck: (data: ReportAckMessage) => void;
  rtcOffer: (data: RtcOfferMessage) => void;
  rtcAnswer: (data: RtcAnswerMessage) => void;
  iceCandidate: (data: IceCandidateMessage) => void;
  [key: string]: (...args: any[]) => void;
}

export class SignalingClient extends EventEmitter<SignalingClientEvents> implements ISignalingClient {
  private ws: WebSocket | null = null;
  private configManager: ConfigManager;
  private clientId: string;
  private movieId: string; // streamId for WhoHas queries
  private _isConnected = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private pendingRequests = new Map<string, {
    resolve: (value: WhoHasReplyMessage) => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
    startTime: number;
  }>();
  // Cache whoHas responses to prevent duplicate queries
  private whoHasCache = new Map<string, {
    response: WhoHasReplyMessage;
    timestamp: number;
  }>();
  private seederEndpoint: string;
  private signalingUrl: string;

  constructor(
    clientId: string,
    movieId: string,
    configManager: ConfigManager,
    seederEndpoint = '/api/v1/streams/movies'
  ) {
    super();
    this.clientId = clientId;
    this.movieId = movieId;
    this.configManager = configManager;
    this.seederEndpoint = seederEndpoint;
    this.signalingUrl = `ws://localhost:8080/ws/signaling?clientId=${clientId}&movieId=${movieId}`;
  }

  /**
   * Connect to signaling server
   */
  async connect(signalingUrl?: string): Promise<void> {
    if (signalingUrl) {
      this.signalingUrl = signalingUrl;
    }

    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.signalingUrl);

        this.ws.onopen = () => {
          console.log('[SignalingClient] Connected to signaling server');
          this._isConnected = true;
          this.emit('connected');
          this.startHeartbeat();
          resolve();
        };

        this.ws.onmessage = (event) => {
          this.handleMessage(event.data);
        };

        this.ws.onerror = (error) => {
          console.error('[SignalingClient] WebSocket error:', error);
          this.emit('error', new Error('WebSocket error'));
        };

        this.ws.onclose = () => {
          console.log('[SignalingClient] Disconnected from signaling server');
          this._isConnected = false;
          this.emit('disconnected');
          this.stopHeartbeat();
          this.scheduleReconnect();
        };

        // Connection timeout
        setTimeout(() => {
          if (!this._isConnected) {
            reject(new Error('Signaling connection timeout'));
            this.ws?.close();
          }
        }, 5000);

      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Disconnect from signaling server
   */
  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.stopHeartbeat();

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this._isConnected = false;
    console.log('[SignalingClient] Manually disconnected');
  }

  /**
   * Query whoHas - Tìm peer có segment
   * Protocol: Client -> Server message type 'whoHas'
   * 
   * @param qualityId - Quality level (ví dụ: "720p")
   * @param segmentId - Segment ID bao gồm cả extension (ví dụ: "seg_0001.m4s")
   * @returns Promise với list of peers có segment
   */
  async whoHas(qualityId: string, segmentId: string): Promise<WhoHasReplyMessage> {
    if (!this._isConnected) {
      console.warn('[SignalingClient] Not connected, cannot query whoHas');
      throw new Error('Not connected to signaling server');
    }

    // Check cache first (cache for 5 seconds)
    const cacheKey = `${this.movieId}_${qualityId}_${segmentId}`;
    const cached = this.whoHasCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < 5000) {
      console.log(`[SignalingClient] Using cached whoHas result for ${segmentId} (${cached.response.peers.length} peers)`);
      return cached.response;
    }

    const request: WhoHasRequest = {
      type: 'whoHas',
      movieId: this.movieId,
      qualityId,
      segmentId,
    };

    const requestId = `whohas_${this.movieId}_${qualityId}_${segmentId}_${Date.now()}`;
    const config = this.configManager.getConfig();
    const startTime = Date.now();

    console.log(`[SignalingClient] whoHas query: movieId=${this.movieId}, ` +
                `qualityId=${qualityId}, segmentId=${segmentId}`);

    return new Promise((resolve, reject) => {
      // Set timeout
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        const elapsed = Date.now() - startTime;
        console.warn(`[SignalingClient] whoHas timeout after ${elapsed}ms for segment ${segmentId}`);
        
        reject(new Error(`whoHas timeout for segment ${qualityId}:${segmentId} after ${elapsed}ms`));
      }, config.whoHasTimeout);

      this.pendingRequests.set(requestId, { 
        resolve: (response) => {
          // Cache the response
          this.whoHasCache.set(cacheKey, {
            response,
            timestamp: Date.now()
          });
          resolve(response);
        }, 
        reject, 
        timeout,
        startTime 
      });

      // Send whoHas message theo protocol
      this.send(request);
    });
  }

  /**
   * Report segment - Báo cáo đã tải segment
   * Protocol: Client -> Server message type 'reportSegment'
   * 
   * @param segmentId - Segment ID bao gồm cả extension (ví dụ: "seg_0001.m4s")
   * @param qualityId - Quality level
   * @param source - Nguồn: 'peer' hoặc 'server'
   * @param latency - Thời gian tải (ms)
   * @param speed - Tốc độ tải (Mbps)
   */
  reportSegmentFetch(
    segmentId: string,
    qualityId: string,
    source: 'peer' | 'server' = 'peer',
    latency?: number,
    speed?: number
  ): void {
    if (!this._isConnected) {
      console.warn('[SignalingClient] Not connected, cannot report segment');
      return;
    }

    const report: ReportSegmentRequest = {
      type: 'reportSegment',
      movieId: this.movieId,  // Optional trong protocol nhưng gửi để chắc chắn
      qualityId,
      segmentId,
      source,
      latency,
      speed,
    };

    console.log(`[SignalingClient] Reporting segment: ${qualityId}:${segmentId} from ${source}` +
                (latency ? ` (latency: ${latency}ms)` : '') +
                (speed ? ` (speed: ${speed}Mbps)` : ''));

    this.send(report);
  }

  /**
   * Get seeder endpoint URL for HTTP fallback
   * 
   * @param qualityId - Quality level ID
   * @param segmentId - Segment ID bao gồm cả extension (ví dụ: "seg_0001.m4s")
   * @returns Full URL to fetch from seeder (e.g., /api/v1/streams/movies/{movieId}/{qualityId}/seg_0001.m4s)
   */
  getSeederUrl(qualityId: string, segmentId: string): string {
    return `${this.seederEndpoint}/${this.movieId}/${qualityId}/${segmentId}`;
  }

  /**
   * Set seeder endpoint for HTTP fallback
   */
  setSeederEndpoint(endpoint: string): void {
    this.seederEndpoint = endpoint;
    console.log(`[SignalingClient] Seeder endpoint set to: ${endpoint}`);
  }

  /**
   * Send WebRTC offer to peer
   * Protocol: Client -> Server message type 'rtcOffer'
   */
  sendOffer(peerId: string, offer: RTCSessionDescriptionInit): void {
    const message: RtcOfferRequest = {
      type: 'rtcOffer',
      to: peerId,
      streamId: this.movieId,
      sdp: offer.sdp || '',
    };
    
    console.log(`[SignalingClient] Sending rtcOffer to ${peerId}`);
    this.send(message);
  }

  /**
   * Send WebRTC answer to peer
   * Protocol: Client -> Server message type 'rtcAnswer'
   */
  sendAnswer(peerId: string, answer: RTCSessionDescriptionInit): void {
    const message: RtcAnswerRequest = {
      type: 'rtcAnswer',
      to: peerId,
      streamId: this.movieId,
      sdp: answer.sdp || '',
    };
    
    console.log(`[SignalingClient] Sending rtcAnswer to ${peerId}`);
    this.send(message);
  }

  /**
   * Send ICE candidate to peer
   * Protocol: Client -> Server message type 'iceCandidate'
   */
  sendIceCandidate(peerId: string, candidate: RTCIceCandidateInit): void {
    const message: IceCandidateRequest = {
      type: 'iceCandidate',
      to: peerId,
      streamId: this.movieId,
      candidate,
    };
    
    console.log(`[SignalingClient] Sending iceCandidate to ${peerId}`);
    this.send(message);
  }

  /**
   * Send message through WebSocket
   * Messages theo Streaming Signaling Protocol đã có type field
   */
  send(message: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn('[SignalingClient] Cannot send message, WebSocket not open');
      return;
    }

    try {
      const payload = JSON.stringify(message);
      console.log('[SignalingClient] Sending message:', payload);
      this.ws.send(payload);
    } catch (error) {
      console.error('[SignalingClient] Error sending message:', error);
      this.emit('error', error as Error);
    }
  }

  /**
   * Handle incoming message from signaling server
   * Parse theo Streaming Signaling Protocol
   */
  private handleMessage(data: string): void {
    try {
      const message = JSON.parse(data) as Record<string, any>;
      const messageType = message.type as string;

      if (!messageType) {
        console.error('[SignalingClient] Message missing type field:', message);
        return;
      }

      switch (messageType) {
        case 'whoHasReply':
          this.handleWhoHasReply(message as WhoHasReplyMessage);
          break;

        case 'peerList':
          this.emit('peerList', message as PeerListMessage);
          break;

        case 'reportAck':
          this.emit('reportAck', message as ReportAckMessage);
          break;

        case 'rtcOffer':
          // Forward RTC message
          this.emit('rtcOffer', message as RtcOfferMessage);
          break;

        case 'rtcAnswer':
          this.emit('rtcAnswer', message as RtcAnswerMessage);
          break;

        case 'iceCandidate':
          this.emit('iceCandidate', message as IceCandidateMessage);
          break;

        case 'error':
          const errorMsg = message as ErrorMessage;
          console.error('[SignalingClient] Server error:', errorMsg.message);
          this.handleServerError(errorMsg);
          break;

        default:
          console.warn('[SignalingClient] Unknown message type:', messageType, message);
      }
    } catch (error) {
      console.error('[SignalingClient] Error parsing message:', error, 'Raw data:', data);
      this.emit('error', new Error('Failed to parse signaling message'));
    }
  }

  /**
   * Handle whoHasReply from signaling server
   * Protocol: Server -> Client message type 'whoHasReply'
   */
  private handleWhoHasReply(message: WhoHasReplyMessage): void {
    console.log(`[SignalingClient] whoHasReply for ${message.segmentId}: ` +
                `${message.peers.length} peers found`);

    // Try to match with pending request by segmentId
    for (const [requestId, pending] of this.pendingRequests.entries()) {
      if (requestId.includes(message.segmentId)) {
        const elapsed = Date.now() - pending.startTime;
        clearTimeout(pending.timeout);
        
        console.log(`[SignalingClient] Matched request ${requestId} in ${elapsed}ms`);
        pending.resolve(message);
        this.pendingRequests.delete(requestId);
        break;
      }
    }

    // Also emit event for general listeners
    this.emit('whoHasReply', message);
  }

  /**
   * Handle error message from server
   * Protocol: Server -> Client message type 'error'
   */
  private handleServerError(errorMsg: ErrorMessage): void {
    console.error('[SignalingClient] Server error:', errorMsg.message);
    
    // Emit general error event
    this.emit('error', new Error(errorMsg.message));
  }

  /**
   * Start heartbeat to keep connection alive
   */
  private startHeartbeat(): void {
    const config = this.configManager.getConfig();
    
    // Skip heartbeat if interval is 0 or negative
    if (config.signalingHeartbeatInterval <= 0) {
      console.log('[SignalingClient] Heartbeat disabled (interval <= 0)');
      return;
    }
    
    this.heartbeatTimer = setInterval(() => {
      if (this._isConnected && this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.send({
          type: 'ping', // Use ping type for heartbeat
          clientId: this.clientId,
          movieId: this.movieId,
          timestamp: Date.now(),
        });
      }
    }, config.signalingHeartbeatInterval);

    console.log(`[SignalingClient] Heartbeat started (interval: ${config.signalingHeartbeatInterval}ms)`);
  }

  /**
   * Stop heartbeat
   */
  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
      console.log('[SignalingClient] Heartbeat stopped');
    }
  }

  /**
   * Schedule reconnection attempt
   */
  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;

    const config = this.configManager.getConfig();

    console.log(`[SignalingClient] Scheduling reconnection in ${config.signalingReconnectInterval}ms`);

    this.reconnectTimer = setTimeout(() => {
      console.log('[SignalingClient] Attempting to reconnect...');
      this.reconnectTimer = null;
      this.connect().catch((error) => {
        console.error('[SignalingClient] Reconnection failed:', error);
        this.emit('error', error);
      });
    }, config.signalingReconnectInterval);
  }

  /**
   * Check if connected to signaling server
   */
  isConnectedToServer(): boolean {
    return this._isConnected && 
           this.ws !== null && 
           this.ws.readyState === WebSocket.OPEN;
  }

  /**
   * Get current movieId (streamId)
   */
  getMovieId(): string {
    return this.movieId;
  }

  /**
   * Get client ID
   */
  getClientId(): string {
    return this.clientId;
  }

  /**
   * Get pending request count (for monitoring)
   */
  getPendingRequestCount(): number {
    return this.pendingRequests.size;
  }

  /**
   * Check if connected (IConnectionManager interface)
   */
  isConnected(): boolean {
    return this._isConnected && this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  /**
   * Reconnect (IConnectionManager interface)
   */
  reconnect(): void {
    this.disconnect();
    this.connect().catch(err => {
      console.error('[SignalingClient] Reconnection failed:', err);
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
    });
  }

  /**
   * Get connection state
   */
  getConnectionState(): 'connecting' | 'connected' | 'disconnected' | 'reconnecting' {
    if (!this.ws) return 'disconnected';
    if (this._isConnected && this.ws.readyState === WebSocket.OPEN) return 'connected';
    if (this.ws.readyState === WebSocket.CONNECTING) return 'connecting';
    if (this.reconnectTimer) return 'reconnecting';
    return 'disconnected';
  }

  /**
   * Get seeder endpoint
   */
  getSeederEndpoint(): string {
    return this.seederEndpoint;
  }

  /**
   * Set reconnection strategy (not implemented yet)
   */
  setReconnectionStrategy(_strategy: any): void {
    // TODO: Implement reconnection strategy pattern
    console.warn('[SignalingClient] setReconnectionStrategy not implemented yet');
  }

  /**
   * Dispose - cleanup all resources
   */
  destroy(): void {
    console.log('[SignalingClient] Disposing signaling client');

    // Reject all pending requests
    this.pendingRequests.forEach(({ reject, timeout }) => {
      clearTimeout(timeout);
      reject(new Error('Signaling client disposed'));
    });
    this.pendingRequests.clear();

    this.disconnect();
  }
}
