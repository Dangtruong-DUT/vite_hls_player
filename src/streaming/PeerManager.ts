/**
 * PeerManager
 * 
 * Advanced P2P connection manager with:
 * - Peer scoring based on latency, upload speed, and reliability
 * - Max concurrent peer connections limit
 * - Lazy connection + staggered requests with random delays
 * - Automatic retry on failure
 * - Connection cleanup after fetch completion
 * - Multi-quality ABR support with quality-based segment lookup
 * - Support for fetching segments around seek position
 * - Automatic fallback to HTTP endpoint on peer failure
 */

import type { PeerInfo, PeerScore, SegmentMetadata, FetchResult } from './types';
import { SignalingClient } from './SignalingClient';
import { ConfigManager } from './ConfigManager';

export interface PeerManagerEvents {
  peerConnected: (peerId: string) => void;
  peerDisconnected: (peerId: string) => void;
  peerScoreUpdated: (peerId: string, score: number) => void;
  fetchFailed: (peerId: string, error: Error) => void;
}

interface PendingSegmentRequest {
  segmentId: number;
  qualityId: string;
  resolve: (data: ArrayBuffer) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  startTime: number;
}

export class PeerManager {
  private configManager: ConfigManager;
  private signalingClient: SignalingClient;
  private peers = new Map<string, PeerInfo>();
  private pendingRequests = new Map<string, PendingSegmentRequest>(); // requestId -> request
  private iceServers: RTCIceServer[] = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ];
  private eventListeners: Partial<PeerManagerEvents> = {};
  private requestIdCounter = 0;
  private lastStaggerDelay = 0;
  // Track recent signaling messages to prevent duplicates
  private recentOffers = new Map<string, number>(); // peerId -> timestamp
  private recentAnswers = new Map<string, number>(); // peerId -> timestamp
  private readonly SIGNALING_DEBOUNCE_MS = 500; // Ignore duplicates within 500ms

  constructor(
    signalingClient: SignalingClient, 
    configManager: ConfigManager
  ) {
    this.signalingClient = signalingClient;
    this.configManager = configManager;
    this.setupSignalingListeners();
  }

  /**
   * Setup signaling client listeners
   */
  private setupSignalingListeners(): void {
    this.signalingClient.on('rtcOffer', async (message) => {
      const offer: RTCSessionDescriptionInit = {
        type: 'offer',
        sdp: message.sdp,
      };
      await this.handlePeerOffer(message.from, offer);
    });

    this.signalingClient.on('rtcAnswer', async (message) => {
      const answer: RTCSessionDescriptionInit = {
        type: 'answer',
        sdp: message.sdp,
      };
      await this.handlePeerAnswer(message.from, answer);
    });

    this.signalingClient.on('iceCandidate', async (message) => {
      await this.handleIceCandidate(message.from, message.candidate);
    });
  }

  /**
   * Lazy connect to peer (only when needed)
   * Will enforce max_active_peers limit by disconnecting lowest scored peer
   */
  async connectToPeer(peerId: string): Promise<PeerInfo> {
    // Check if already connected or connecting
    const existing = this.peers.get(peerId);
    if (existing && (existing.connectionState === 'connected' || existing.connectionState === 'connecting')) {
      return existing;
    }

    // Check max peers limit
    const config = this.configManager.getConfig();
    const activePeers = this.getActivePeerCount();
    if (activePeers >= config.maxActivePeers) {
      console.log(`[PeerManager] Max peers (${config.maxActivePeers}) reached, disconnecting lowest scored peer`);
      this.disconnectLowestScoredPeer();
    }

    // Create peer connection
    const peerConnection = new RTCPeerConnection({ iceServers: this.iceServers });
    const dataChannel = peerConnection.createDataChannel('segments', {
      ordered: true,
      maxRetransmits: 3,
    });

    const peerInfo: PeerInfo = {
      peerId,
      connectionState: 'connecting',
      peerConnection,
      dataChannel,
      score: 0.5, // Initial neutral score
      availableSegments: new Set(),
      lastActive: Date.now(),
      metrics: {
        successCount: 0,
        failureCount: 0,
        avgLatency: 0,
        bytesReceived: 0,
      },
    };

    this.peers.set(peerId, peerInfo);

    // Setup connection event handlers
    this.setupPeerConnectionHandlers(peerInfo);
    this.setupDataChannelHandlers(peerInfo);

    // Create and send offer
    try {
      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);
      this.signalingClient.sendOffer(peerId, offer);
      
      console.log(`[PeerManager] Initiated connection to peer ${peerId}`);
    } catch (error) {
      console.error(`[PeerManager] Failed to create offer for ${peerId}:`, error);
      this.disconnectPeer(peerId);
      throw error;
    }

    return peerInfo;
  }

  /**
   * Handle incoming peer offer
   */
  private async handlePeerOffer(peerId: string, offer: RTCSessionDescriptionInit): Promise<void> {
    try {
      // Check for duplicate offer (debounce)
      const lastOfferTime = this.recentOffers.get(peerId);
      const now = Date.now();
      if (lastOfferTime && (now - lastOfferTime) < this.SIGNALING_DEBOUNCE_MS) {
        console.log(`[PeerManager] Ignoring duplicate offer from ${peerId} (within ${this.SIGNALING_DEBOUNCE_MS}ms)`);
        return;
      }
      this.recentOffers.set(peerId, now);

      // Validate offer
      if (!offer || !offer.type || !offer.sdp) {
        console.error(`[PeerManager] Invalid offer from ${peerId}:`, {
          hasOffer: !!offer,
          type: offer?.type,
          hasSdp: !!offer?.sdp,
          sdpLength: offer?.sdp?.length || 0
        });
        return;
      }

      console.log(`[PeerManager] Received valid offer from ${peerId} (SDP length: ${offer.sdp.length})`);

      // Check if peer already exists
      const existingPeer = this.peers.get(peerId);
      if (existingPeer) {
        console.log(`[PeerManager] Peer ${peerId} already exists, cleaning up old connection`);
        this.disconnectPeer(peerId);
        // Wait a bit for cleanup to complete
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      // Check max peers limit before accepting
      const config = this.configManager.getConfig();
      const activePeers = this.getActivePeerCount();
      if (activePeers >= config.maxActivePeers) {
        console.log(`[PeerManager] Max peers reached, rejecting offer from ${peerId}`);
        return;
      }

      const peerConnection = new RTCPeerConnection({ iceServers: this.iceServers });

      const peerInfo: PeerInfo = {
        peerId,
        connectionState: 'connecting',
        peerConnection,
        score: 0.5,
        availableSegments: new Set(),
        lastActive: Date.now(),
        metrics: {
          successCount: 0,
          failureCount: 0,
          avgLatency: 0,
          bytesReceived: 0,
        },
      };

      this.peers.set(peerId, peerInfo);
      this.setupPeerConnectionHandlers(peerInfo);

      // Handle data channel from remote
      peerConnection.ondatachannel = (event) => {
        peerInfo.dataChannel = event.channel;
        this.setupDataChannelHandlers(peerInfo);
      };

      // Check signaling state before setting remote description
      if (peerConnection.signalingState !== 'stable') {
        console.warn(`[PeerManager] Peer connection not in stable state: ${peerConnection.signalingState}`);
      }

      await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);

      this.signalingClient.sendAnswer(peerId, answer);
      console.log(`[PeerManager] Accepted connection from peer ${peerId}`);
    } catch (error) {
      console.error(`[PeerManager] Failed to handle offer from ${peerId}:`, error);
      this.disconnectPeer(peerId);
    }
  }

  /**
   * Handle peer answer
   */
  private async handlePeerAnswer(peerId: string, answer: RTCSessionDescriptionInit): Promise<void> {
    // Check for duplicate answer (debounce)
    const lastAnswerTime = this.recentAnswers.get(peerId);
    const now = Date.now();
    if (lastAnswerTime && (now - lastAnswerTime) < this.SIGNALING_DEBOUNCE_MS) {
      console.log(`[PeerManager] Ignoring duplicate answer from ${peerId} (within ${this.SIGNALING_DEBOUNCE_MS}ms)`);
      return;
    }
    this.recentAnswers.set(peerId, now);

    const peer = this.peers.get(peerId);
    if (!peer || !peer.peerConnection) {
      console.warn(`[PeerManager] Received answer for unknown peer ${peerId}`);
      return;
    }

    try {
      // Validate answer
      if (!answer || !answer.type || !answer.sdp) {
        console.error(`[PeerManager] Invalid answer from ${peerId}:`, {
          hasAnswer: !!answer,
          type: answer?.type,
          hasSdp: !!answer?.sdp,
          sdpLength: answer?.sdp?.length || 0
        });
        this.disconnectPeer(peerId);
        return;
      }

      console.log(`[PeerManager] Received valid answer from ${peerId} (SDP length: ${answer.sdp.length})`);

      // Check signaling state
      const signalingState = peer.peerConnection.signalingState;
      if (signalingState !== 'have-local-offer') {
        console.warn(`[PeerManager] Unexpected signaling state for ${peerId}: ${signalingState}`);
        if (signalingState === 'stable' || signalingState === 'closed') {
          console.log(`[PeerManager] Ignoring answer for peer ${peerId} in ${signalingState} state`);
          return;
        }
      }

      await peer.peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
      console.log(`[PeerManager] Set remote description for peer ${peerId}`);
    } catch (error) {
      console.error(`[PeerManager] Failed to set remote description for ${peerId}:`, error);
      this.disconnectPeer(peerId);
    }
  }

  /**
   * Handle ICE candidate
   */
  private async handleIceCandidate(peerId: string, candidate: RTCIceCandidateInit): Promise<void> {
    const peer = this.peers.get(peerId);
    if (!peer || !peer.peerConnection) {
      console.warn(`[PeerManager] Received ICE candidate for unknown peer ${peerId}`);
      return;
    }

    // Check if peer connection is in a valid state for adding ICE candidates
    const signalingState = peer.peerConnection.signalingState;
    if (signalingState === 'closed') {
      console.warn(`[PeerManager] Cannot add ICE candidate for closed peer ${peerId}`);
      return;
    }

    try {
      await peer.peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (error) {
      console.error(`[PeerManager] Failed to add ICE candidate for ${peerId}:`, error);
    }
  }

  /**
   * Setup peer connection handlers
   */
  private setupPeerConnectionHandlers(peerInfo: PeerInfo): void {
    const { peerId, peerConnection } = peerInfo;
    if (!peerConnection) return;

    peerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        this.signalingClient.sendIceCandidate(peerId, event.candidate.toJSON());
      }
    };

    peerConnection.onconnectionstatechange = () => {
      const state = peerConnection.connectionState;
      peerInfo.connectionState = state as PeerInfo['connectionState'];

      console.log(`[PeerManager] Peer ${peerId} connection state: ${state}`);

      if (state === 'connected') {
        this.emit('peerConnected', peerId);
      } else if (state === 'disconnected' || state === 'failed') {
        this.emit('peerDisconnected', peerId);
        this.disconnectPeer(peerId);
      }
    };

    peerConnection.onicecandidateerror = (error) => {
      console.error(`[PeerManager] ICE candidate error for ${peerId}:`, error);
    };
  }

  /**
   * Setup data channel handlers
   */
  private setupDataChannelHandlers(peerInfo: PeerInfo): void {
    const { peerId, dataChannel } = peerInfo;
    if (!dataChannel) return;

    dataChannel.onopen = () => {
      console.log(`[PeerManager] Data channel opened for ${peerId}`);
      peerInfo.connectionState = 'connected';
    };

    dataChannel.onclose = () => {
      console.log(`[PeerManager] Data channel closed for ${peerId}`);
      // Update connection state when data channel closes
      peerInfo.connectionState = 'disconnected';
      // Schedule cleanup to remove the peer
      setTimeout(() => {
        if (peerInfo.connectionState === 'disconnected') {
          console.log(`[PeerManager] Cleaning up disconnected peer ${peerId}`);
          this.disconnectPeer(peerId);
        }
      }, 1000); // Wait 1 second before cleanup
    };

    dataChannel.onerror = (error) => {
      console.error(`[PeerManager] Data channel error for ${peerId}:`, error);
      // Update connection state on error
      peerInfo.connectionState = 'failed';
      this.emit('fetchFailed', peerId, new Error('Data channel error'));
      // Immediately disconnect failed peer
      setTimeout(() => {
        console.log(`[PeerManager] Cleaning up failed peer ${peerId}`);
        this.disconnectPeer(peerId);
      }, 500);
    };

    dataChannel.onmessage = (event) => {
      this.handleDataChannelMessage(peerInfo, event.data);
    };
  }

  /**
   * Handle data channel message
   */
  private handleDataChannelMessage(peerInfo: PeerInfo, data: ArrayBuffer | string): void {
    peerInfo.lastActive = Date.now();

    // Handle different message types
    if (typeof data === 'string') {
      try {
        const message = JSON.parse(data);
        
        // Handle segment availability updates
        if (message.type === 'segmentAvailability') {
          message.segments.forEach((segmentKey: string) => {
            peerInfo.availableSegments.add(segmentKey);
          });
        }
        
        // Handle error responses
        else if (message.type === 'error') {
          const requestId = message.requestId;
          const pending = this.pendingRequests.get(requestId);
          if (pending) {
            clearTimeout(pending.timeout);
            this.pendingRequests.delete(requestId);
            pending.reject(new Error(message.error || 'Peer returned error'));
          }
        }
      } catch (error) {
        console.error('[PeerManager] Failed to parse message:', error);
      }
    } 
    // Handle binary segment data
    else if (data instanceof ArrayBuffer) {
      // Extract requestId from first 4 bytes (simple protocol)
      const view = new DataView(data);
      const requestId = view.getUint32(0, true).toString();
      const segmentData = data.slice(4);
      
      const pending = this.pendingRequests.get(requestId);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pendingRequests.delete(requestId);
        pending.resolve(segmentData);
      }
    }
  }

  /**
   * Fetch segment from peer with retry logic
   * @param peerId - Target peer ID
   * @param segment - Segment metadata
   * @param retryCount - Current retry attempt
   * @returns FetchResult with data or error
   */
  async fetchSegmentFromPeer(
    peerId: string,
    segment: SegmentMetadata,
    retryCount = 0
  ): Promise<FetchResult> {
    const config = this.configManager.getConfig();
    const startTime = Date.now();

    // Get or connect to peer
    let peer = this.peers.get(peerId);
    const isConnected = peer?.connectionState === 'connected' && 
                       peer?.dataChannel?.readyState === 'open';
    
    if (!peer || !isConnected) {
      try {
        peer = await this.connectToPeer(peerId);
        // Wait for connection to establish with shorter timeout (2s instead of 10s)
        await this.waitForConnection(peer, Math.min(2000, config.peerConnectionTimeout));
      } catch (error) {
        console.error(`[PeerManager] Failed to connect to peer ${peerId}:`, error);
        // Return error instead of falling back to HTTP
        // Let IntegratedSegmentFetchClient handle the fallback
        return {
          success: false,
          source: 'peer' as const,
          peerId,
          latency: Date.now() - startTime,
          error: error instanceof Error ? error : new Error('Connection failed'),
        };
      }
    }

    // Check if data channel is ready
    if (!peer.dataChannel || peer.dataChannel.readyState !== 'open') {
      console.warn(`[PeerManager] Data channel not ready for ${peerId}`);
      // Return error instead of falling back to HTTP
      return {
        success: false,
        source: 'peer' as const,
        peerId,
        latency: Date.now() - startTime,
        error: new Error('Data channel not ready'),
      };
    }

    try {
      // Apply staggered delay
      const staggerDelay = this.getStaggeredDelay();
      if (staggerDelay > 0) {
        await this.sleep(staggerDelay);
      }

      // Re-check data channel after delay (it might have closed)
      if (!peer.dataChannel || peer.dataChannel.readyState !== 'open') {
        console.warn(`[PeerManager] Data channel closed during delay for ${peerId}`);
        return {
          success: false,
          source: 'peer' as const,
          peerId,
          latency: Date.now() - startTime,
          error: new Error('Data channel closed'),
        };
      }

      // Create request
      const requestId = (this.requestIdCounter++).toString();
      const request = {
        type: 'segmentRequest',
        requestId,
        segmentId: segment.id,
        qualityId: segment.qualityId,
      };

      // Send request with try-catch to handle send failures
      try {
        peer.dataChannel.send(JSON.stringify(request));
      } catch (sendError) {
        console.error(`[PeerManager] Failed to send request to ${peerId}:`, sendError);
        return {
          success: false,
          source: 'peer' as const,
          peerId,
          latency: Date.now() - startTime,
          error: sendError instanceof Error ? sendError : new Error('Failed to send request'),
        };
      }

      // Wait for response with shorter timeout (3s instead of 8s for faster fallback)
      const segmentTimeout = Math.min(3000, config.fetchTimeout);
      const data = await this.waitForSegmentData(requestId, peer, segmentTimeout);

      // Update metrics - success
      const latency = Date.now() - startTime;
      this.updatePeerMetrics(peer, true, latency, data.byteLength);
      this.updatePeerScore(peerId);

      console.log(`[PeerManager] Fetched segment ${segment.qualityId}:${segment.id} from peer ${peerId} in ${latency}ms`);

      return {
        success: true,
        data,
        source: 'peer' as const,
        peerId,
        latency,
      };

    } catch (error) {
      // Update metrics - failure
      this.updatePeerMetrics(peer, false, Date.now() - startTime, 0);
      this.updatePeerScore(peerId);

      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error(`[PeerManager] Failed to fetch from peer ${peerId}: ${errorMessage}`);
      
      this.emit('fetchFailed', peerId, error as Error);

      // Don't retry if data channel is not ready (it won't succeed)
      const isChannelError = errorMessage.includes('Data channel') || 
                            errorMessage.includes('send');
      
      if (isChannelError) {
        console.log(`[PeerManager] Channel error detected, skipping retry for ${peerId}`);
        return {
          success: false,
          source: 'peer' as const,
          peerId,
          latency: Date.now() - startTime,
          error: error instanceof Error ? error : new Error('Channel error'),
        };
      }

      // Retry logic with reduced retries for faster fallback
      // Only retry once (reduce from 3 to 1) for faster fallback to HTTP
      const maxRetries = 1;
      if (retryCount < maxRetries) {
        const retryDelay = config.retryDelayBase * Math.pow(2, retryCount);
        console.log(`[PeerManager] Retrying in ${retryDelay}ms (attempt ${retryCount + 1}/${maxRetries})`);
        await this.sleep(retryDelay);
        return this.fetchSegmentFromPeer(peerId, segment, retryCount + 1);
      }

      // Max retries exceeded, return error instead of falling back to HTTP
      // Let IntegratedSegmentFetchClient handle the fallback
      console.log(`[PeerManager] Max retries exceeded for peer ${peerId}`);
      return {
        success: false,
        source: 'peer' as const,
        peerId,
        latency: Date.now() - startTime,
        error: error instanceof Error ? error : new Error('Max retries exceeded'),
      };
    }
  }

  /**
   * Fetch segment with automatic peer selection and fallback
   * Supports multi-quality ABR by looking up segment by qualityId
   * @param segment - Segment to fetch (with qualityId)
   * @returns FetchResult with data or error
   */
  async fetchSegment(segment: SegmentMetadata): Promise<FetchResult> {
    const segmentKey = `${segment.qualityId}:${segment.id}`;
    const bestPeers = this.getBestPeersForSegment(segmentKey, 3);

    if (bestPeers.length === 0) {
      console.log(`[PeerManager] No peers available for segment ${segmentKey}, using HTTP fallback`);
      return this.fallbackToHttp(segment, Date.now());
    }

    // Try best peer first
    const result = await this.fetchSegmentFromPeer(bestPeers[0].peerId, segment);
    
    // Close connection after successful fetch (resource cleanup)
    if (result.success && result.peerId) {
      this.scheduleConnectionCleanup(result.peerId);
    }

    return result;
  }

  /**
   * Fetch segments around seek position
   * Fetches current segment + segments ahead and behind
   * @param currentSegment - Current segment after seek
   * @param allSegments - All available segments for current quality
   * @param windowAhead - Number of segments to fetch ahead
   * @param windowBehind - Number of segments to fetch behind
   */
  async fetchSegmentsAroundSeek(
    currentSegment: SegmentMetadata,
    allSegments: SegmentMetadata[],
    windowAhead = 3,
    windowBehind = 1
  ): Promise<FetchResult[]> {
    const currentIndex = allSegments.findIndex(s => s.id === currentSegment.id);
    if (currentIndex === -1) {
      console.warn(`[PeerManager] Current segment not found in segment list`);
      return [];
    }

    const segmentsToFetch: SegmentMetadata[] = [];
    
    // Add segments behind
    for (let i = Math.max(0, currentIndex - windowBehind); i < currentIndex; i++) {
      if (allSegments[i].qualityId === currentSegment.qualityId) {
        segmentsToFetch.push(allSegments[i]);
      }
    }
    
    // Add current segment
    segmentsToFetch.push(currentSegment);
    
    // Add segments ahead
    for (let i = currentIndex + 1; i <= Math.min(allSegments.length - 1, currentIndex + windowAhead); i++) {
      if (allSegments[i].qualityId === currentSegment.qualityId) {
        segmentsToFetch.push(allSegments[i]);
      }
    }

    console.log(`[PeerManager] Fetching ${segmentsToFetch.length} segments around seek position`);

    // Fetch segments with priority (current first, then ahead, then behind)
    const results = await Promise.all(
      segmentsToFetch.map(segment => this.fetchSegment(segment))
    );

    return results;
  }

  /**
   * Wait for peer connection to be established
   */
  private async waitForConnection(peer: PeerInfo, timeout: number): Promise<void> {
    const startTime = Date.now();
    
    while (Date.now() - startTime < timeout) {
      if (peer.connectionState === 'connected' && peer.dataChannel?.readyState === 'open') {
        return;
      }
      if (peer.connectionState === 'failed' || peer.connectionState === 'disconnected') {
        throw new Error('Connection failed');
      }
      await this.sleep(100);
    }
    
    throw new Error('Connection timeout');
  }

  /**
   * Wait for segment data response
   */
  private async waitForSegmentData(
    requestId: string,
    peer: PeerInfo,
    timeout: number
  ): Promise<ArrayBuffer> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error(`Segment request timeout from peer ${peer.peerId}`));
      }, timeout);

      this.pendingRequests.set(requestId, {
        segmentId: 0, // Not needed for resolution
        qualityId: '',
        resolve,
        reject,
        timeout: timer,
        startTime: Date.now(),
      });
    });
  }

  /**
   * Fallback to HTTP endpoint when peer fetch fails
   */
  private async fallbackToHttp(segment: SegmentMetadata, startTime: number): Promise<FetchResult> {
    try {
      // segment.id already contains the full filename with extension (e.g., "seg_0001.m4s")
      const url = this.configManager.getSeederUrl(segment.movieId, segment.qualityId,segment.id);
      
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.arrayBuffer();
      const latency = Date.now() - startTime;

      return {
        success: true,
        data,
        source: 'origin' as const,
        latency,
      };
    } catch (error) {
      console.error(`[PeerManager] HTTP fallback failed:`, error);
      return {
        success: false,
        source: 'origin' as const,
        latency: Date.now() - startTime,
        error: error as Error,
      };
    }
  }

  /**
   * Update peer metrics after fetch attempt
   */
  private updatePeerMetrics(
    peer: PeerInfo,
    success: boolean,
    latency: number,
    bytesReceived: number
  ): void {
    if (success) {
      peer.metrics.successCount++;
      peer.metrics.bytesReceived += bytesReceived;
      
      // Update average latency with exponential moving average
      const alpha = 0.3; // Smoothing factor
      peer.metrics.avgLatency = peer.metrics.avgLatency === 0
        ? latency
        : alpha * latency + (1 - alpha) * peer.metrics.avgLatency;
    } else {
      peer.metrics.failureCount++;
    }
    
    peer.lastActive = Date.now();
  }

  /**
   * Calculate peer score based on latency, upload speed (bytes/success), and reliability
   * Score components:
   * - Reliability (success rate): 50% weight
   * - Latency: 30% weight  
   * - Upload speed: 20% weight
   */
  private updatePeerScore(peerId: string): void {
    const peer = this.peers.get(peerId);
    if (!peer) return;

    const { metrics } = peer;
    const totalRequests = metrics.successCount + metrics.failureCount;
    
    // Need minimum data for accurate scoring
    if (totalRequests === 0) {
      peer.score = 0.5;
      return;
    }

    // 1. Reliability score (success rate)
    const reliabilityScore = metrics.successCount / totalRequests;

    // 2. Latency score (inverse normalized, lower is better)
    // Assume 100ms is excellent, 2000ms is poor
    const latencyScore = Math.max(0, Math.min(1, 1 - (metrics.avgLatency - 100) / 1900));

    // 3. Upload speed score (bytes per successful request)
    const avgBytesPerRequest = metrics.successCount > 0 
      ? metrics.bytesReceived / metrics.successCount 
      : 0;
    // Assume 1MB per segment is good, normalize to 0-1
    const uploadSpeedScore = Math.min(1, avgBytesPerRequest / (1024 * 1024));

    // Weighted combination
    peer.score = (
      reliabilityScore * 0.5 +
      latencyScore * 0.3 +
      uploadSpeedScore * 0.2
    );

    console.log(
      `[PeerManager] Updated score for ${peerId}: ${peer.score.toFixed(3)} ` +
      `(reliability: ${reliabilityScore.toFixed(2)}, latency: ${latencyScore.toFixed(2)}, ` +
      `upload: ${uploadSpeedScore.toFixed(2)})`
    );

    this.emit('peerScoreUpdated', peerId, peer.score);

    // Disconnect if score too low (after minimum sample size)
    const config = this.configManager.getConfig();
    if (peer.score < config.peerScoreThreshold && totalRequests >= 5) {
      console.log(`[PeerManager] Disconnecting low-scored peer ${peerId} (score: ${peer.score.toFixed(3)})`);
      this.disconnectPeer(peerId);
    }
  }

  /**
   * Get best peers for a specific segment (ABR multi-quality support)
   * Looks up segment by qualityId:segmentId key
   */
  getBestPeersForSegment(segmentKey: string, count = 3): PeerScore[] {
    const candidates: PeerScore[] = [];

    this.peers.forEach((peer, peerId) => {
      // Only consider connected peers with open data channel that have the segment
      const isReady = peer.connectionState === 'connected' && 
                     peer.dataChannel?.readyState === 'open';
      
      if (isReady && peer.availableSegments.has(segmentKey)) {
        const totalRequests = peer.metrics.successCount + peer.metrics.failureCount;
        const successRate = totalRequests > 0 
          ? peer.metrics.successCount / totalRequests 
          : 0.5;

        candidates.push({
          peerId,
          score: peer.score,
          latency: peer.metrics.avgLatency,
          successRate,
          availability: 1.0,
        });
      }
    });

    // Sort by score descending, then by latency ascending
    return candidates
      .sort((a, b) => {
        if (Math.abs(a.score - b.score) > 0.1) {
          return b.score - a.score;
        }
        return a.latency - b.latency;
      })
      .slice(0, count);
  }

  /**
   * Get staggered delay with random component
   * Prevents thundering herd when multiple segments requested
   */
  private getStaggeredDelay(): number {
    const config = this.configManager.getConfig();
    const baseDelay = config.staggeredRequestDelay;
    
    // Add random jitter: 50-150% of base delay
    const jitter = baseDelay * (0.5 + Math.random());
    
    // Simple rate limiting: increase delay if requests too frequent
    const timeSinceLastStagger = Date.now() - this.lastStaggerDelay;
    this.lastStaggerDelay = Date.now();
    
    if (timeSinceLastStagger < baseDelay) {
      return jitter * 1.5; // Increase delay if requests too close
    }
    
    return jitter;
  }

  /**
   * Schedule connection cleanup after fetch completion
   * Keeps connection alive for a short period in case of more requests
   */
  private scheduleConnectionCleanup(peerId: string, delayMs = 30000): void {
    setTimeout(() => {
      const peer = this.peers.get(peerId);
      if (peer && Date.now() - peer.lastActive > delayMs) {
        console.log(`[PeerManager] Cleaning up idle connection to ${peerId}`);
        this.disconnectPeer(peerId);
      }
    }, delayMs);
  }

  /**
   * Disconnect specific peer and clean up resources
   */
  disconnectPeer(peerId: string): void {
    const peer = this.peers.get(peerId);
    if (!peer) return;

    console.log(`[PeerManager] Disconnecting peer ${peerId}`);

    // Mark as disconnecting to prevent new operations
    peer.connectionState = 'disconnected';

    // Clean up pending requests for this peer
    this.pendingRequests.forEach((request, requestId) => {
      clearTimeout(request.timeout);
      request.reject(new Error(`Peer ${peerId} disconnected`));
      this.pendingRequests.delete(requestId);
    });

    // Clean up signaling debounce tracking
    this.recentOffers.delete(peerId);
    this.recentAnswers.delete(peerId);

    // Close data channel first
    if (peer.dataChannel) {
      try {
        peer.dataChannel.close();
      } catch (error) {
        console.warn(`[PeerManager] Error closing data channel for ${peerId}:`, error);
      }
      peer.dataChannel = undefined;
    }

    // Close peer connection
    if (peer.peerConnection) {
      try {
        // Remove event listeners to prevent callbacks during cleanup
        peer.peerConnection.onicecandidate = null;
        peer.peerConnection.oniceconnectionstatechange = null;
        peer.peerConnection.onconnectionstatechange = null;
        peer.peerConnection.ondatachannel = null;
        
        peer.peerConnection.close();
      } catch (error) {
        console.warn(`[PeerManager] Error closing peer connection for ${peerId}:`, error);
      }
      peer.peerConnection = undefined;
    }

    this.peers.delete(peerId);
    this.emit('peerDisconnected', peerId);
  }

  /**
   * Disconnect lowest scored peer to make room for new connections
   */
  private disconnectLowestScoredPeer(): void {
    let lowestScore = Infinity;
    let lowestPeerId: string | null = null;

    this.peers.forEach((peer, peerId) => {
      if (peer.connectionState === 'connected' && peer.score < lowestScore) {
        lowestScore = peer.score;
        lowestPeerId = peerId;
      }
    });

    if (lowestPeerId) {
      console.log(`[PeerManager] Disconnecting lowest scored peer: ${lowestPeerId} (score: ${lowestScore.toFixed(3)})`);
      this.disconnectPeer(lowestPeerId);
    }
  }

  /**
   * Get active (connected) peer count
   */
  getActivePeerCount(): number {
    let count = 0;
    this.peers.forEach(peer => {
      // Count both connecting and connected peers for max limit
      // But exclude failed/disconnected peers
      if (peer.connectionState === 'connected' || peer.connectionState === 'connecting') {
        count++;
      }
    });
    return count;
  }

  /**
   * Get all connected peers
   */
  getConnectedPeers(): PeerInfo[] {
    const connected: PeerInfo[] = [];
    this.peers.forEach(peer => {
      if (peer.connectionState === 'connected') {
        connected.push(peer);
      }
    });
    return connected;
  }

  /**
   * Get peer statistics for monitoring
   */
  getPeerStats(): Array<{
    peerId: string;
    state: string;
    score: number;
    successRate: number;
    avgLatency: number;
    totalBytes: number;
    availableSegments: number;
  }> {
    const stats: ReturnType<typeof this.getPeerStats> = [];
    
    this.peers.forEach((peer, peerId) => {
      const totalRequests = peer.metrics.successCount + peer.metrics.failureCount;
      stats.push({
        peerId,
        state: peer.connectionState,
        score: peer.score,
        successRate: totalRequests > 0 ? peer.metrics.successCount / totalRequests : 0,
        avgLatency: peer.metrics.avgLatency,
        totalBytes: peer.metrics.bytesReceived,
        availableSegments: peer.availableSegments.size,
      });
    });

    return stats;
  }

  /**
   * Update peer segment availability from signaling
   */
  updatePeerSegmentAvailability(peerId: string, segmentKeys: string[]): void {
    const peer = this.peers.get(peerId);
    if (!peer) return;

    peer.availableSegments.clear();
    segmentKeys.forEach(key => peer.availableSegments.add(key));
    
    console.log(`[PeerManager] Updated availability for ${peerId}: ${segmentKeys.length} segments`);
  }

  /**
   * Sleep utility
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Event emitter - subscribe to events
   */
  on<K extends keyof PeerManagerEvents>(event: K, listener: PeerManagerEvents[K]): void {
    this.eventListeners[event] = listener;
  }

  /**
   * Emit event to listeners
   */
  private emit<K extends keyof PeerManagerEvents>(
    event: K,
    ...args: Parameters<NonNullable<PeerManagerEvents[K]>>
  ): void {
    const listener = this.eventListeners[event];
    if (listener) {
      // @ts-expect-error - TypeScript has trouble with spread args
      listener(...args);
    }
  }

  /**
   * Cleanup all connections and resources
   */
  dispose(): void {
    console.log('[PeerManager] Disposing all peer connections');
    
    // Clear all pending requests
    this.pendingRequests.forEach((request) => {
      clearTimeout(request.timeout);
      request.reject(new Error('PeerManager disposed'));
    });
    this.pendingRequests.clear();

    // Disconnect all peers
    this.peers.forEach((_, peerId) => this.disconnectPeer(peerId));
    this.peers.clear();
    
    this.eventListeners = {};
  }
}
