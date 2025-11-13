/**
 * SignalingClient
 * 
 * Advanced WebSocket signaling client with:
 * - WhoHas query based on streamId (movieId) and segmentId for seek position
 * - Report successful segment fetches (from peer or seeder) to update Redis
 * - Redis updates so swarm knows which peers have which segments
 * - Timeout support with HTTP fallback on slow signaling
 * - Seeder endpoint knowledge for HTTP fallback: /api/streams/movies/...
 */

import type { WhoHasRequest, WhoHasResponse, SegmentAvailabilityReport, SignalingMessage, FetchSource } from './types';
import { ConfigManager } from './ConfigManager';

export interface SignalingClientEvents {
  connected: () => void;
  disconnected: () => void;
  error: (error: Error) => void;
  whoHasResponse: (response: WhoHasResponse) => void;
  peerOffer: (data: { peerId: string; offer: RTCSessionDescriptionInit }) => void;
  peerAnswer: (data: { peerId: string; answer: RTCSessionDescriptionInit }) => void;
  iceCandidate: (data: { peerId: string; candidate: RTCIceCandidateInit }) => void;
  timeoutFallback: (segmentId: number, qualityId: string) => void;
}

interface SegmentFetchReport {
  clientId: string;
  movieId: string;
  segmentId: number;
  qualityId: string;
  source: FetchSource; // 'peer' or 'seeder'
  timestamp: number;
  latency?: number;
  peerId?: string; // If fetched from peer
}

export class SignalingClient {
  private ws: WebSocket | null = null;
  private configManager: ConfigManager;
  private clientId: string;
  private movieId: string; // streamId for WhoHas queries
  private isConnected = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private pendingRequests = new Map<string, {
    resolve: (value: WhoHasResponse) => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
    startTime: number;
  }>();
  private eventListeners: Partial<SignalingClientEvents> = {};
  private seederEndpoint: string;
  private signalingUrl: string;

  constructor(
    clientId: string,
    movieId: string,
    configManager: ConfigManager,
    seederEndpoint = '/api/streams/movies'
  ) {
    this.clientId = clientId;
    this.movieId = movieId;
    this.configManager = configManager;
    this.seederEndpoint = seederEndpoint;
    this.signalingUrl = `ws://localhost:8080/signaling?clientId=${clientId}&movieId=${movieId}`;
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
          this.isConnected = true;
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
          this.isConnected = false;
          this.emit('disconnected');
          this.stopHeartbeat();
          this.scheduleReconnect();
        };

        // Connection timeout
        setTimeout(() => {
          if (!this.isConnected) {
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

    this.isConnected = false;
    console.log('[SignalingClient] Manually disconnected');
  }

  /**
   * Query WhoHas based on streamId (movieId) and segmentId
   * Used to find peers that have a specific segment, especially for seek positions
   * 
   * @param qualityId - Quality level ID
   * @param segmentId - Segment ID (corresponds to seek position)
   * @returns Promise<WhoHasResponse> with list of peer IDs that have the segment
   * @throws Error if timeout occurs (triggers HTTP fallback)
   */
  async whoHas(qualityId: string, segmentId: number): Promise<WhoHasResponse> {
    if (!this.isConnected) {
      console.warn('[SignalingClient] Not connected, cannot query WhoHas');
      throw new Error('Not connected to signaling server');
    }

    const request: WhoHasRequest = {
      movieId: this.movieId, // streamId for query
      qualityId,
      segmentId,
    };

    const requestId = `whohas_${this.movieId}_${qualityId}_${segmentId}_${Date.now()}`;
    const config = this.configManager.getConfig();
    const startTime = Date.now();

    console.log(`[SignalingClient] WhoHas query: movieId=${this.movieId}, ` +
                `qualityId=${qualityId}, segmentId=${segmentId}`);

    return new Promise((resolve, reject) => {
      // Set timeout - will trigger HTTP fallback
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        const elapsed = Date.now() - startTime;
        console.warn(`[SignalingClient] WhoHas timeout after ${elapsed}ms for segment ${segmentId}`);
        
        // Emit timeout event for HTTP fallback
        this.emit('timeoutFallback', segmentId, qualityId);
        
        reject(new Error(`WhoHas timeout for segment ${qualityId}:${segmentId} after ${elapsed}ms`));
      }, config.whoHasTimeout);

      this.pendingRequests.set(requestId, { 
        resolve, 
        reject, 
        timeout,
        startTime 
      });

      // Send WhoHas message
      this.send({
        type: 'whoHas',
        payload: { ...request, requestId },
        timestamp: Date.now(),
      });
    });
  }

  /**
   * Report successful segment fetch to update Redis
   * Lets the swarm know which peers have which segments
   * 
   * @param segmentId - Segment ID that was fetched
   * @param qualityId - Quality level ID
   * @param source - Source of fetch: 'peer' or 'seeder'
   * @param peerId - Peer ID if fetched from peer
   * @param latency - Fetch latency in ms (optional)
   */
  reportSegmentFetch(
    segmentId: number,
    qualityId: string,
    source: FetchSource,
    peerId?: string,
    latency?: number
  ): void {
    if (!this.isConnected) {
      console.warn('[SignalingClient] Not connected, cannot report segment fetch');
      return;
    }

    const report: SegmentFetchReport = {
      clientId: this.clientId,
      movieId: this.movieId,
      segmentId,
      qualityId,
      source,
      timestamp: Date.now(),
      latency,
      peerId,
    };

    console.log(`[SignalingClient] Reporting segment fetch: ${qualityId}:${segmentId} from ${source}` +
                (peerId ? ` (peer: ${peerId})` : ''));

    this.send({
      type: 'segmentFetchReport',
      payload: report,
      timestamp: Date.now(),
    });
  }

  /**
   * Report segment availability to update Redis
   * Used to advertise which segments this client has available
   * Updates Redis so other peers can discover this client's segments
   * 
   * @param segments - Array of segments this client has
   */
  reportSegmentAvailability(segments: Array<{ qualityId: string; segmentId: number }>): void {
    if (!this.isConnected) {
      console.warn('[SignalingClient] Not connected, cannot report availability');
      return;
    }

    const report: SegmentAvailabilityReport = {
      clientId: this.clientId,
      movieId: this.movieId,
      segments,
    };

    console.log(`[SignalingClient] Reporting ${segments.length} available segments for movieId=${this.movieId}`);

    this.send({
      type: 'segmentReport',
      payload: report,
      timestamp: Date.now(),
    });
  }

  /**
   * Get seeder endpoint URL for HTTP fallback
   * Format: /api/streams/movies/{movieId}/{qualityId}/{segmentId}.m4s
   * 
   * @param qualityId - Quality level ID
   * @param segmentId - Segment ID
   * @returns Full URL to fetch from seeder
   */
  getSeederUrl(qualityId: string, segmentId: number): string {
    return `${this.seederEndpoint}/${this.movieId}/${qualityId}/${segmentId}.m4s`;
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
   */
  sendOffer(peerId: string, offer: RTCSessionDescriptionInit): void {
    this.send({
      type: 'peerOffer',
      payload: { 
        senderId: this.clientId,
        targetPeerId: peerId, 
        offer 
      },
      timestamp: Date.now(),
    });
  }

  /**
   * Send WebRTC answer to peer
   */
  sendAnswer(peerId: string, answer: RTCSessionDescriptionInit): void {
    this.send({
      type: 'peerAnswer',
      payload: { 
        senderId: this.clientId,
        targetPeerId: peerId, 
        answer 
      },
      timestamp: Date.now(),
    });
  }

  /**
   * Send ICE candidate to peer
   */
  sendIceCandidate(peerId: string, candidate: RTCIceCandidateInit): void {
    this.send({
      type: 'iceCandidate',
      payload: { 
        senderId: this.clientId,
        targetPeerId: peerId, 
        candidate 
      },
      timestamp: Date.now(),
    });
  }

  /**
   * Send message through WebSocket
   */
  private send(message: SignalingMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn('[SignalingClient] Cannot send message, WebSocket not open');
      return;
    }

    try {
      this.ws.send(JSON.stringify(message));
    } catch (error) {
      console.error('[SignalingClient] Error sending message:', error);
      this.emit('error', error as Error);
    }
  }

  /**
   * Handle incoming message from signaling server
   */
  private handleMessage(data: string): void {
    try {
      const message: SignalingMessage & { payload: any } = JSON.parse(data);

      switch (message.type) {
        case 'whoHasResponse':
          this.handleWhoHasResponse(message.payload);
          break;

        case 'peerOffer':
          this.emit('peerOffer', {
            peerId: message.payload.senderId || message.payload.peerId,
            offer: message.payload.offer
          });
          break;

        case 'peerAnswer':
          this.emit('peerAnswer', {
            peerId: message.payload.senderId || message.payload.peerId,
            answer: message.payload.answer
          });
          break;

        case 'iceCandidate':
          this.emit('iceCandidate', {
            peerId: message.payload.senderId || message.payload.peerId,
            candidate: message.payload.candidate
          });
          break;

        case 'error':
          console.error('[SignalingClient] Server error:', message.payload);
          this.emit('error', new Error(message.payload.message || 'Server error'));
          break;

        default:
          console.warn('[SignalingClient] Unknown message type:', message.type);
      }
    } catch (error) {
      console.error('[SignalingClient] Error parsing message:', error);
      this.emit('error', new Error('Failed to parse signaling message'));
    }
  }

  /**
   * Handle WhoHas response from signaling server
   * Updates Redis knowledge of segment distribution across swarm
   */
  private handleWhoHasResponse(response: WhoHasResponse & { requestId?: string }): void {
    const requestId = response.requestId;
    
    if (requestId) {
      const pending = this.pendingRequests.get(requestId);
      if (pending) {
        const elapsed = Date.now() - pending.startTime;
        clearTimeout(pending.timeout);
        
        console.log(`[SignalingClient] WhoHas response received in ${elapsed}ms: ` +
                    `${response.peers.length} peers have segment ${response.segmentKey}`);
        
        pending.resolve(response);
        this.pendingRequests.delete(requestId);
      }
    }

    // Also emit event for general listeners
    this.emit('whoHasResponse', response);
  }

  /**
   * Start heartbeat to keep connection alive
   */
  private startHeartbeat(): void {
    const config = this.configManager.getConfig();
    
    this.heartbeatTimer = setInterval(() => {
      if (this.isConnected && this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.send({
          type: 'whoHas', // Reuse whoHas type for heartbeat
          payload: { 
            heartbeat: true,
            clientId: this.clientId,
            movieId: this.movieId 
          },
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
    return this.isConnected && 
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
   * Event subscription
   */
  on<K extends keyof SignalingClientEvents>(event: K, listener: SignalingClientEvents[K]): void {
    this.eventListeners[event] = listener;
  }

  /**
   * Emit event to listeners
   */
  private emit<K extends keyof SignalingClientEvents>(
    event: K,
    ...args: Parameters<NonNullable<SignalingClientEvents[K]>>
  ): void {
    const listener = this.eventListeners[event];
    if (listener) {
      // @ts-expect-error - TypeScript has trouble with spread args
      listener(...args);
    }
  }

  /**
   * Cleanup and disconnect
   */
  dispose(): void {
    console.log('[SignalingClient] Disposing signaling client');

    // Reject all pending requests
    this.pendingRequests.forEach(({ reject, timeout }) => {
      clearTimeout(timeout);
      reject(new Error('Signaling client disposed'));
    });
    this.pendingRequests.clear();

    this.disconnect();
    this.eventListeners = {};
  }
}
