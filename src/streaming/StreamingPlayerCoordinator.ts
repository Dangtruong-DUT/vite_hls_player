/**
 * Streaming Player Coordinator
 * Orchestrates all streaming modules together for seamless video playback
 */

import type { Quality, SegmentMetadata, PlayerState, PlaybackMetrics } from './types';
import { ConfigManager } from './ConfigManager';
import { MseManager } from './MseManager';
import { CacheManager } from './CacheManager';
import { SegmentFetcher } from './SegmentFetcher';
import { BufferManager } from './BufferManager';
import { PeerManager } from './PeerManager';
import { SignalingClient } from './SignalingClient';
import { IntegratedSegmentFetchClient } from './IntegratedSegmentFetchClient';
import { AbrManager } from './AbrManager';

export interface StreamingPlayerOptions {
  movieId: string;
  clientId: string;
  videoElement: HTMLVideoElement;
  signalingUrl?: string;
  configOverrides?: Partial<import('./types').StreamingConfig>;
}

export interface StreamingPlayerEvents {
  ready: () => void;
  playing: () => void;
  paused: () => void;
  seeking: () => void;
  buffering: () => void;
  qualityChanged: (quality: Quality) => void;
  error: (error: Error) => void;
}

export class StreamingPlayerCoordinator {
  // Core modules
  private configManager: ConfigManager;
  private mseManager: MseManager;
  private cacheManager: CacheManager;
  private segmentFetcher: SegmentFetcher;
  private bufferManager: BufferManager;
  private peerManager: PeerManager;
  private signalingClient: SignalingClient;
  private integratedFetchClient: IntegratedSegmentFetchClient;
  private abrManager: AbrManager;

  // State
  private videoElement: HTMLVideoElement;
  private movieId: string;
  private clientId: string;
  private currentQuality: Quality | null = null;
  private availableQualities: Quality[] = [];
  private currentSegments: SegmentMetadata[] = [];
  private isInitialized = false;
  private abrEnabled = true; // controls whether ABR can automatically switch qualities
  private eventListeners: Partial<StreamingPlayerEvents> = {};

  constructor(options: StreamingPlayerOptions) {
    this.movieId = options.movieId;
    this.clientId = options.clientId;
    this.videoElement = options.videoElement;

    // Initialize configuration
    this.configManager = new ConfigManager(options.configOverrides);

    // Initialize cache với config
    this.cacheManager = new CacheManager({
      maxSize: this.configManager.get('cacheSizeLimit'),
      segmentTTL: 30 * 60 * 1000, // 30 minutes
      initTTL: 24 * 60 * 60 * 1000, // 24 hours
      playlistTTL: 60 * 60 * 1000, // 1 hour
      hotCacheProtection: true, // Enable hot cache protection
    });

    // Initialize MSE
    this.mseManager = new MseManager(this.videoElement);

    // Initialize segment fetcher
    this.segmentFetcher = new SegmentFetcher(
      this.movieId,
      this.cacheManager,
      this.configManager
    );

    // Initialize buffer manager
    this.bufferManager = new BufferManager(
      this.videoElement,
      this.mseManager,
      this.configManager
    );

    // Initialize signaling
    this.signalingClient = new SignalingClient(
      this.clientId,
      this.movieId,
      this.configManager
    );

    // Initialize peer manager
    this.peerManager = new PeerManager(
      this.movieId,
      this.signalingClient,
      this.configManager,
      this.cacheManager
    );

    // Initialize integrated fetch client
    this.integratedFetchClient = new IntegratedSegmentFetchClient(
      this.movieId,
      this.signalingClient,
      this.peerManager,
      this.cacheManager,
      this.segmentFetcher,
      this.mseManager,
      this.configManager
    );

    // Initialize ABR manager
    this.abrManager = new AbrManager(
      this.movieId,
      this.peerManager,
      this.signalingClient,
      this.cacheManager,
      this.configManager
    );

    this.setupEventListeners();
    this.setupBufferManagerFetchCallback();
  }

  /**
   * Setup fetch callback cho BufferManager
   */
  private setupBufferManagerFetchCallback(): void {
    this.bufferManager.setFetchCallback(async (segment, critical) => {
      try {
        const result = await this.integratedFetchClient.fetchSegment({
          segment,
          priority: critical ? 100 : 50,
          forSeek: false,
          critical: critical, // Pass critical flag to skip P2P when buffer is critically low
        });

        if (result.success && result.data) {
          return result.data;
        }
        
        return null;
      } catch (error) {
        console.error(`[Coordinator] Fetch failed for segment ${segment.id}:`, error);
        return null;
      }
    });
  }

  /**
   * Setup internal event listeners
   */
  private setupEventListeners(): void {
    // MSE events
    this.mseManager.on('sourceOpen', () => {
      console.log('[Coordinator] MSE source opened');
    });

    this.mseManager.on('error', (error) => {
      this.emit('error', error);
    });

    this.mseManager.on('qualityChanged', (quality) => {
      this.currentQuality = quality;
      this.emit('qualityChanged', quality);
    });

    // Buffer events
    this.bufferManager.on('bufferingStart', () => {
      this.emit('buffering');
    });

    this.bufferManager.on('bufferLow', (bufferAhead) => {
      console.log(`[Coordinator] Buffer low: ${bufferAhead.toFixed(2)}s`);
    });

    this.bufferManager.on('bufferCritical', (bufferAhead) => {
      console.warn(`[Coordinator] Buffer CRITICAL: ${bufferAhead.toFixed(2)}s`);
      this.emit('buffering'); // Notify UI
    });

    this.bufferManager.on('qualitySwitch', (from, to) => {
      console.log(`[Coordinator] Quality switched: ${from} → ${to}`);
      // Trigger ABR decision
      this.checkAbrSwitch();
    });

    // Signaling events
    this.signalingClient.on('connected', () => {
      console.log('[Coordinator] Connected to signaling server');
      this.reportAvailableSegments();
    });

    this.signalingClient.on('whoHasReply', (message) => {
      // Update peer availability information
      if (message.peers && message.peers.length > 0) {
        message.peers.forEach(peer => {
          this.peerManager.updatePeerSegmentAvailability(peer.peerId, [message.segmentId]);
        });
      }
    });

    this.signalingClient.on('peerList', (message) => {
      // Handle initial peer list from server
    });

    // Peer events
    this.peerManager.on('peerConnected', (peerId) => {
      console.log(`[Coordinator] Peer connected: ${peerId}`);
    });

    this.peerManager.on('peerDisconnected', (peerId) => {
      console.log(`[Coordinator] Peer disconnected: ${peerId}`);
    });

    // ABR events
    this.abrManager.on('qualityChanged', (oldQuality, newQuality, reason) => {
      console.log(`[Coordinator] ABR quality changed: ${oldQuality?.id || 'none'} → ${newQuality.id} (${reason})`);
      this.currentQuality = newQuality;
      this.emit('qualityChanged', newQuality);
    });

    // Video element events
    this.videoElement.addEventListener('play', () => {
      this.emit('playing');
    });

    this.videoElement.addEventListener('pause', () => {
      this.emit('paused');
    });

    this.videoElement.addEventListener('seeking', () => {
      this.emit('seeking');
    });
  }

  /**
   * Initialize the player
   */
  async initialize(): Promise<void> {
    try {
      console.log('[Coordinator] Initializing streaming player...');

      // Connect to signaling server
      await this.signalingClient.connect();

      // Fetch master playlist
      const masterPlaylist = await this.segmentFetcher.fetchMasterPlaylist();
      this.availableQualities = masterPlaylist.qualities;

      if (this.availableQualities.length === 0) {
        throw new Error('No qualities available');
      }

      // Initialize ABR manager with master playlist
      await this.abrManager.initialize(masterPlaylist);

      // Get initial quality from ABR manager
      const initialQuality = this.abrManager.getCurrentQuality();
      if (!initialQuality) {
        throw new Error('ABR manager failed to select initial quality');
      }
      
      // Fetch variant playlist
      const variantPlaylist = await this.segmentFetcher.fetchVariantPlaylist(initialQuality.id);
      this.currentSegments = variantPlaylist.segments;

      // Cache variant playlist (auto-stores time mapping for seek)
      this.cacheManager.setVariantPlaylist(this.movieId, initialQuality.id, variantPlaylist);

      // Fetch init segment
      const initSegment = await this.segmentFetcher.fetchInitSegment(initialQuality.id);

      // Initialize MSE
      const mimeType = `video/mp4; codecs="${initialQuality.codecs}"`;
      await this.mseManager.initialize(mimeType);

      // Set duration từ playlist
      this.mseManager.setDuration(variantPlaylist.totalDuration);

      // Append init segment
      await this.mseManager.appendInitSegment(initSegment);

      // Initialize buffer manager
      await this.bufferManager.initialize(initialQuality, this.currentSegments);

      this.currentQuality = initialQuality;
      this.isInitialized = true;

      console.log('[Coordinator] Initialization complete');
      this.emit('ready');

    } catch (error) {
      console.error('[Coordinator] Initialization failed:', error);
      this.emit('error', error as Error);
      throw error;
    }
  }



  /**
   * Report available segments to signaling server
   */
  private reportAvailableSegments(): void {
    if (!this.currentQuality) return;

    // Get appended segments (now returns string keys like "720p:0")
    const appendedSegments = this.bufferManager.getAppendedSegments();
    
    // Parse segment keys to extract segment IDs
    const segments = appendedSegments
      .map(key => {
        const parts = key.split(':');
        if (parts.length === 2) {
          return {
            qualityId: parts[0],
            segmentId: parseInt(parts[1], 10),
          };
        }
        return null;
      })
      .filter((seg): seg is { qualityId: string; segmentId: number } => seg !== null);

    // Note: reportSegmentAvailability has been replaced with individual reportSegment calls
    // Segments are reported as they are fetched via signalingClient.reportSegmentFetch()
  }

  /**
   * Switch quality (manual or ABR)
   */
  async switchQuality(qualityId: string): Promise<void> {
    const newQuality = this.availableQualities.find(q => q.id === qualityId);
    if (!newQuality || newQuality.id === this.currentQuality?.id) {
      return;
    }

    console.log(`[Coordinator] Switching quality to ${qualityId}`);

    try {
      // Use ABR manager to switch quality (fetches init segment)
      await this.abrManager.setQuality(newQuality, 'manual');

      // Try to retrieve init segment prepared by AbrManager
      let initSegment = this.abrManager.getInitSegment(qualityId as string);

      // Fallback: fetch init segment from segmentFetcher if not present
      if (!initSegment) {
        try {
          initSegment = await this.segmentFetcher.fetchInitSegment(qualityId as string);
        } catch (err) {
          console.warn('[Coordinator] Failed to fetch init segment for quality during switch:', err);
        }
      }

      // Instruct MSE to switch quality using the init segment so playback continues from current time
      if (initSegment) {
        try {
          // Use MSE's switchQuality to remove buffered ranges ahead of current time and append init
          await this.mseManager.switchQuality(newQuality, initSegment);
        } catch (mseErr) {
          console.warn('[Coordinator] MSE quality switch failed, attempting to append init segment directly:', mseErr);
          try {
            await this.mseManager.appendInitSegment(initSegment);
          } catch (appendErr) {
            console.error('[Coordinator] Failed to append init segment during quality switch:', appendErr);
            this.emit('error', appendErr as Error);
          }
        }

        // Ensure variant playlist for new quality is available
        let variantPlaylist = this.cacheManager.getVariantPlaylist(this.movieId, qualityId);

        if (!variantPlaylist) {
          try {
            variantPlaylist = await this.segmentFetcher.fetchVariantPlaylist(qualityId);
          } catch (playlistErr) {
            console.error('[Coordinator] Failed to load variant playlist during quality switch:', playlistErr);
            throw playlistErr;
          }
        }

        const newSegments = variantPlaylist?.segments || [];

        if (newSegments.length === 0) {
          console.warn('[Coordinator] Variant playlist has no segments for quality switch, aborting buffer update');
        } else {
          // Notify BufferManager about the quality change and new segments but skip init append
          try {
            await this.bufferManager.switchQuality(
              newQuality,
              newSegments,
              { data: initSegment.data, url: initSegment.url },
              true
            );
          } catch (bmErr) {
            console.warn('[Coordinator] BufferManager quality update failed:', bmErr);
          }

          // Update current state
          this.currentSegments = newSegments;
        }
      }

      this.currentQuality = newQuality;

      console.log(`[Coordinator] Quality switched to ${qualityId}`);

    } catch (error) {
      console.error('[Coordinator] Quality switch failed:', error);
      this.emit('error', error as Error);
    }
  }

  /**
   * Enable automatic ABR switching
   */
  enableAutoQuality(): void {
    this.abrEnabled = true;
    console.log('[Coordinator] ABR enabled');
  }

  /**
   * Disable automatic ABR switching (manual mode)
   */
  disableAutoQuality(): void {
    this.abrEnabled = false;
    console.log('[Coordinator] ABR disabled (manual mode)');
  }

  /**
   * Set quality and switch to manual mode
   */
  async setManualQuality(qualityId: string): Promise<void> {
    this.disableAutoQuality();
    await this.switchQuality(qualityId);
  }

  /**
   * Play video
   */
  async play(): Promise<void> {
    if (!this.isInitialized) {
      await this.initialize();
    }
    await this.videoElement.play();
  }

  /**
   * Pause video
   */
  pause(): void {
    this.videoElement.pause();
  }

  /**
   * Seek to time (với cache-aware prefetch)
   */
  async seek(time: number): Promise<void> {
    if (!this.currentQuality) {
      console.warn('[Coordinator] Cannot seek: no quality selected');
      return;
    }

    // Use cache to map time → segmentId
    const targetSegmentId = this.cacheManager.mapTimeToSegmentId(
      this.movieId,
      this.currentQuality.id,
      time
    );

    if (targetSegmentId !== null) {
      console.log(`[Coordinator] Seek ${time}s → segment ${targetSegmentId}`);
      
      // Get segments around seek point for prefetch
      const prefetchSegments = this.cacheManager.getSegmentsAroundTime(
        this.movieId,
        this.currentQuality.id,
        time,
        2, // 2 before
        5  // 5 after
      );

      console.log(`[Coordinator] Prefetch segments: [${prefetchSegments.map(s => s.id).join(', ')}]`);
    }

    // Perform seek
    this.videoElement.currentTime = time;
    
    // BufferManager will handle prefetching segments around seek position
    // No need to call fetchSegmentsAroundSeek here as BufferManager does it automatically
  }

  /**
   * Get current player state
   */
  getPlayerState(): PlayerState {
    return {
      isPlaying: !this.videoElement.paused,
      isPaused: this.videoElement.paused,
      isSeeking: this.videoElement.seeking,
      isBuffering: this.videoElement.readyState < 3,
      currentTime: this.videoElement.currentTime,
      duration: this.videoElement.duration || 0,
      currentQuality: this.currentQuality,
      availableQualities: this.availableQualities,
      volume: this.videoElement.volume,
      muted: this.videoElement.muted,
    };
  }

  /**
   * Get playback metrics
   */
  getPlaybackMetrics(): PlaybackMetrics {
    const bufferStatus = this.bufferManager.getBufferStatus();
    const config = this.configManager.getConfig();
    const bufferHealth = Math.min(bufferStatus.bufferAhead / config.bufferTargetDuration, 1);

    const activePeers = this.peerManager.getActivePeerCount();
    const p2pRatio = this.integratedFetchClient.getP2pRatio();

    return {
      bufferHealth,
      downloadSpeed: 0, // TODO: Calculate from recent fetches
      bandwidthEstimate: this.currentQuality?.bandwidth || 0,
      droppedFrames: 0, // TODO: Get from video element
      stallCount: 0, // TODO: Track stalls
      totalStallTime: 0,
      p2pRatio,
      activeConnections: activePeers,
    };
  }

  /**
   * Get available qualities
   */
  getAvailableQualities(): Quality[] {
    return [...this.availableQualities];
  }

  /**
   * Get current quality
   */
  getCurrentQuality(): Quality | null {
    return this.currentQuality;
  }

  /**
   * Get cache stats (with hot cache breakdown)
   */
  getCacheStats() {
    return {
      ...this.cacheManager.getStats(),
      breakdown: this.cacheManager.getCacheBreakdown(),
      hitRate: (this.cacheManager.getHitRate() * 100).toFixed(1) + '%',
      usagePercentage: this.cacheManager.getUsagePercentage().toFixed(1) + '%',
      hotCacheKeys: this.cacheManager.getHotCacheKeys(),
    };
  }

  /**
   * Set volume
   */
  setVolume(volume: number): void {
    this.videoElement.volume = Math.max(0, Math.min(1, volume));
  }

  /**
   * Set muted
   */
  setMuted(muted: boolean): void {
    this.videoElement.muted = muted;
  }

  /**
   * Event emitter
   */
  on<K extends keyof StreamingPlayerEvents>(event: K, listener: StreamingPlayerEvents[K]): void {
    this.eventListeners[event] = listener;
  }

  private emit<K extends keyof StreamingPlayerEvents>(
    event: K,
    ...args: Parameters<NonNullable<StreamingPlayerEvents[K]>>
  ): void {
    const listener = this.eventListeners[event];
    if (listener) {
      // @ts-expect-error - TypeScript has trouble with spread args
      listener(...args);
    }
  }

  /**
   * Get fetch statistics
   */
  getFetchStats() {
    return this.integratedFetchClient.getStats();
  }

  /**
   * Cleanup and dispose all resources
   */
  dispose(): void {
    console.log('[Coordinator] Disposing streaming player');

    this.bufferManager.dispose();
    this.mseManager.dispose();
    this.peerManager.dispose();
    this.signalingClient.dispose();
    this.cacheManager.clear();
    this.segmentFetcher.cancelAllFetches();
    this.integratedFetchClient.dispose();

    this.isInitialized = false;
    this.eventListeners = {};
  }

  /**
   * Check if ABR should switch quality based on current conditions
   */
  private async checkAbrSwitch(): Promise<void> {
    if (!this.isInitialized || !this.currentQuality) return;
    if (!this.abrEnabled) return; // ABR disabled (manual mode)

    const bufferStatus = this.bufferManager.getBufferStatus();
    const metrics = this.getPlaybackMetrics();

    // Simple ABR logic: if buffer is healthy and bandwidth allows, try higher quality
    const config = this.configManager.getConfig();
    if (bufferStatus.bufferAhead > config.bufferTargetDuration * 0.8 && metrics.bandwidthEstimate > this.currentQuality.bandwidth * 1.2) {
      const higherQuality = this.availableQualities
        .filter(q => q.bandwidth > this.currentQuality!.bandwidth)
        .sort((a, b) => a.bandwidth - b.bandwidth)[0];

      if (higherQuality) {
        console.log(`[Coordinator] ABR: Upgrading to ${higherQuality.id} (${bufferStatus.bufferAhead.toFixed(2)}s buffer)`);
        await this.switchQuality(higherQuality.id);
      }
    }
    // If buffer is low, downgrade quality
    else if (bufferStatus.bufferAhead < config.bufferTargetDuration * 0.3) {
      const lowerQuality = this.availableQualities
        .filter(q => q.bandwidth < this.currentQuality!.bandwidth)
        .sort((a, b) => b.bandwidth - a.bandwidth)[0];

      if (lowerQuality) {
        console.log(`[Coordinator] ABR: Downgrading to ${lowerQuality.id} (${bufferStatus.bufferAhead.toFixed(2)}s buffer)`);
        await this.switchQuality(lowerQuality.id);
      }
    }
  }
}
