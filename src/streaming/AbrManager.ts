import type {
  Quality,
  MasterPlaylist,
  VariantPlaylist,
  InitSegment,
  SegmentMetadata,
  BufferStatus,
} from './types';
import { PeerManager } from './PeerManager';
import { SignalingClient } from './SignalingClient';
import { CacheManager } from './CacheManager';
import { ConfigManager, APP_CONSTANTS } from './ConfigManager';
import { EventEmitter } from './interfaces/IEventEmitter';
import type { IBandwidthEstimationStrategy, IQualitySelectionStrategy } from './interfaces/IAbrManager';

export interface AbrManagerEvents {
  qualityChanged: (oldQuality: Quality | null, newQuality: Quality, reason: string) => void;
  initSegmentFetched: (qualityId: string, size: number) => void;
  bandwidthEstimated: (bandwidth: number) => void;
  segmentFetched: (segmentId: string, qualityId: string, source: string) => void;
  prefetchComplete: (count: number, qualityId: string) => void;
  [key: string]: (...args: any[]) => void;
}

export class AbrManager extends EventEmitter<AbrManagerEvents> {
  private configManager: ConfigManager;
  private peerManager: PeerManager;
  private signalingClient: SignalingClient;
  private cacheManager: CacheManager;
  
  private movieId: string; // streamId - remains constant
  private masterPlaylist: MasterPlaylist | null = null;
  private variantPlaylists = new Map<string, VariantPlaylist>(); // qualityId -> playlist
  private initSegments = new Map<string, InitSegment>(); // qualityId -> init segment
  
  private currentQuality: Quality | null = null;
  private isQualitySwitching = false;
  
  // Bandwidth estimation
  private bandwidthSamples: number[] = [];
  private estimatedBandwidth = 0;
  
  // Prefetch state
  private prefetchedSegments = new Set<string>(); // Set of "qualityId:segmentId"
  
  // Strategy pattern support
  private bandwidthStrategy: IBandwidthEstimationStrategy | null = null;
  private qualityStrategy: IQualitySelectionStrategy | null = null;

  constructor(
    movieId: string,
    peerManager: PeerManager,
    signalingClient: SignalingClient,
    cacheManager: CacheManager,
    configManager: ConfigManager,
  ) {
    super();
    this.movieId = movieId;
    this.peerManager = peerManager;
    this.signalingClient = signalingClient;
    this.cacheManager = cacheManager;
    this.configManager = configManager;
  }

  async initialize(masterPlaylist: MasterPlaylist): Promise<void> {
    this.masterPlaylist = masterPlaylist;
    
    console.log(`[AbrManager] Initializing with ${masterPlaylist.qualities.length} quality variants`);

    await Promise.all(
      masterPlaylist.qualities.map(quality => this.loadVariantPlaylist(quality.id))
    );

    const defaultQualityId = masterPlaylist.defaultQualityId || masterPlaylist.qualities[0].id;
    const defaultQuality = masterPlaylist.qualities.find(q => q.id === defaultQualityId);
    
    if (defaultQuality) {
      await this.setQuality(defaultQuality, 'initial');
    }

    console.log(`[AbrManager] Initialized with quality: ${defaultQuality?.id}`);
  }

  /**
   * Load variant playlist for a specific quality
   */
  async loadVariantPlaylist(qualityId: string): Promise<VariantPlaylist> {
    // Check if already loaded
    const existing = this.variantPlaylists.get(qualityId);
    if (existing) {
      return existing;
    }

    try {
      const url = this.configManager.getSeederUrl(this.movieId, qualityId, 'playlist.m3u8');
      const response = await fetch(url);
      
      if (!response.ok) {
        throw new Error(`Failed to load playlist: ${response.status}`);
      }

      const playlistText = await response.text();
      const playlist = this.parseM3U8Playlist(qualityId, playlistText);
      
      this.variantPlaylists.set(qualityId, playlist);
      
      console.log(`[AbrManager] Loaded playlist for ${qualityId}: ${playlist.segments.length} segments`);
      return playlist;
    } catch (error) {
      console.error(`[AbrManager] Failed to load playlist for ${qualityId}:`, error);
      throw error;
    }
  }

  /**
   * Parse M3U8 playlist
   */
  private parseM3U8Playlist(qualityId: string, content: string): VariantPlaylist {
    const lines = content.split('\n').filter(line => line.trim());
    const segments: SegmentMetadata[] = [];
    let targetDuration = 0;
    let currentTimestamp = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      if (line.startsWith('#EXT-X-TARGETDURATION:')) {
        targetDuration = parseFloat(line.split(':')[1]);
      }

      if (line.startsWith('#EXTINF:')) {
        const duration = parseFloat(line.split(':')[1].split(',')[0]);
        const nextLine = lines[i + 1];
        
        if (nextLine && !nextLine.startsWith('#')) {
          // Extract segment ID from filename (e.g., "seg_0042.m4s")
          let segmentId: string;
          const formatMatch = nextLine.match(APP_CONSTANTS.SEGMENT_PATTERNS.REGEX);

          if (formatMatch) {
            segmentId = formatMatch[0]; // "seg_0042.m4s"
          } else {
            throw new Error(`Failed to extract segment ID from: ${nextLine}`);
          }

          segments.push({
            id: segmentId,
            movieId: this.movieId,
            qualityId,
            duration,
            timestamp: currentTimestamp
          });

          currentTimestamp += duration;
          i++; // Skip next line
        }
      }
    }

    const totalDuration = segments.reduce((sum, seg) => sum + seg.duration, 0);

    return {
      qualityId,
      segments,
      targetDuration,
      totalDuration,
    };
  }

  async setQuality(quality: Quality, reason: string): Promise<void> {
    const oldQuality = this.currentQuality;

    if (oldQuality?.id === quality.id && !this.isQualitySwitching) {
      return;
    }

    console.log(`[AbrManager] Quality switch: ${oldQuality?.id || 'none'} -> ${quality.id} (${reason})`);

    this.isQualitySwitching = true;

    try {
      await this.ensureInitSegment(quality.id);
      this.currentQuality = quality;
      this.isQualitySwitching = false;
      this.emit('qualityChanged', oldQuality, quality, reason);
      console.log(`[AbrManager] Quality switched to ${quality.id}`);
    } catch (error) {
      console.error(`[AbrManager] Failed to switch quality:`, error);
      this.isQualitySwitching = false;
      throw error;
    }
  }

  /**
   * Ensure init segment is loaded and cached for a quality
   * Each quality variant has its own init segment
   */
  private async ensureInitSegment(qualityId: string): Promise<InitSegment> {
    // Check cache first
    const cached = this.cacheManager.getInitSegment(this.movieId, qualityId);

    if (cached) {
      console.log(`[AbrManager] Using cached init segment for ${qualityId}`);
      this.initSegments.set(qualityId, cached);
      return cached;
    }

    // Fetch from seeder endpoint
    console.log(`[AbrManager] Fetching init segment for ${qualityId}`);
    const url = this.configManager.getSeederUrl(this.movieId, qualityId, 'init.mp4');

    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Failed to fetch init segment: ${response.status}`);
      }

      const data = await response.arrayBuffer();
      
      const initSegment: InitSegment = {
        qualityId,
        data,
        url,
      };

      // Cache init segment with long TTL
      this.cacheManager.setInitSegment(this.movieId, qualityId, initSegment);

      this.initSegments.set(qualityId, initSegment);
      this.emit('initSegmentFetched', qualityId, data.byteLength);

      console.log(`[AbrManager] Init segment fetched for ${qualityId}: ${data.byteLength} bytes`);

      return initSegment;
    } catch (error) {
      console.error(`[AbrManager] Failed to fetch init segment for ${qualityId}:`, error);
      throw error;
    }
  }

  async fetchSegment(
    segmentId: string,
    qualityId?: string
  ): Promise<ArrayBuffer> {
    const targetQualityId = qualityId || this.currentQuality?.id;

    if (!targetQualityId) {
      throw new Error('No quality selected');
    }

    const playlist = this.variantPlaylists.get(targetQualityId);
    if (!playlist) {
      throw new Error(`No playlist for quality ${targetQualityId}`);
    }

    const segment = playlist.segments.find(s => s.id === segmentId);
    if (!segment) {
      throw new Error(`Segment ${segmentId} not found in ${targetQualityId} playlist`);
    }

    const cacheKey = `${this.movieId}:${targetQualityId}:${segmentId}`;
    const cached = this.cacheManager.get<ArrayBuffer>(cacheKey);

    if (cached) {
      console.log(`[AbrManager] Cache hit: ${cacheKey}`);
      this.emit('segmentFetched', segmentId, targetQualityId, 'cache');
      return cached;
    }
    
    const startTime = Date.now();
    const result = await this.peerManager.fetchSegment(segment);

    if (result.success && result.data) {
      const latency = Date.now() - startTime;
      
      // Update bandwidth estimation
      this.updateBandwidthEstimate(result.data.byteLength, latency);

      // Cache the segment
      const config = this.configManager.getConfig();
      this.cacheManager.set(cacheKey, result.data, config.cacheSegmentTTL);

      // Report to signaling for swarm coordination
      const segmentFilename = segmentId;
      // Map internal FetchSource to protocol source type
      const reportSource: 'peer' | 'server' | undefined = 
        result.source === 'peer' ? 'peer' : 
        (result.source === 'seeder' || result.source === 'origin') ? 'server' :
        undefined; // cache doesn't need reporting
      
      if (reportSource) {
        this.signalingClient.reportSegmentFetch(
          segmentFilename,
          targetQualityId,
          reportSource,
          latency
        );
      }

      this.emit('segmentFetched', segmentId, targetQualityId, result.source);

      console.log(`[AbrManager] Segment ${cacheKey} fetched from ${result.source} in ${latency}ms`);

      return result.data;
    }

    throw new Error(`Failed to fetch segment ${cacheKey}`);
  }

  /**
   * Handle seek: fetch init segment + surrounding segments in current quality
   * 
   * @param seekTime - Target seek time in seconds
   * @returns Init segment and surrounding segment data
   */
  async handleSeek(seekTime: number): Promise<{
    initSegment: InitSegment;
    segments: ArrayBuffer[];
  }> {
    if (!this.currentQuality) {
      throw new Error('No quality selected');
    }

    console.log(`[AbrManager] Handling seek to ${seekTime}s in quality ${this.currentQuality.id}`);

    const qualityId = this.currentQuality.id;
    const playlist = this.variantPlaylists.get(qualityId);

    if (!playlist) {
      throw new Error(`No playlist for quality ${qualityId}`);
    }

    // 1. Ensure init segment is loaded for current quality
    const initSegment = await this.ensureInitSegment(qualityId);

    // 2. Find segment at seek position
    const currentSegment = this.findSegmentAtTime(seekTime, qualityId);
    
    if (!currentSegment) {
      throw new Error(`No segment found at time ${seekTime}`);
    }

    console.log(`[AbrManager] Seek position ${seekTime}s -> segment ${currentSegment.id}`);

    // 3. Fetch surrounding segments
    const config = this.configManager.getConfig();
    const windowAhead = Math.ceil(config.prefetchWindowAhead / playlist.targetDuration);
    const windowBehind = Math.ceil(config.prefetchWindowBehind / playlist.targetDuration);

    const segmentsToFetch: SegmentMetadata[] = [];

    // Find current segment index
    const currentIndex = playlist.segments.findIndex(s => s.id === currentSegment.id);
    if (currentIndex === -1) {
      throw new Error(`Current segment not found in playlist`);
    }

    // Add segments behind (by index)
    for (let i = Math.max(0, currentIndex - windowBehind); i < currentIndex; i++) {
      segmentsToFetch.push(playlist.segments[i]);
    }

    // Add current segment
    segmentsToFetch.push(currentSegment);

    // Add segments ahead (by index)
    for (let i = currentIndex + 1; i <= Math.min(playlist.segments.length - 1, currentIndex + windowAhead); i++) {
      segmentsToFetch.push(playlist.segments[i]);
    }

    console.log(`[AbrManager] Fetching ${segmentsToFetch.length} segments around seek position`);

    // 4. Fetch segments in parallel
    const segmentDataPromises = segmentsToFetch.map(seg => 
      this.fetchSegment(seg.id, qualityId)
    );

    const segments = await Promise.all(segmentDataPromises);

    console.log(`[AbrManager] Seek fetch complete: init + ${segments.length} segments`);

    return {
      initSegment,
      segments,
    };
  }

  /**
   * Prefetch next segments in current quality
   * Called after quality switch or during normal playback
   * 
   * @param currentSegmentId - Current playback segment ID (format: "seg_0001.m4s")
   * @param count - Number of segments to prefetch ahead
   */
  async prefetchNextSegments(
    currentSegmentId: string,
    count?: number
  ): Promise<void> {
    if (!this.currentQuality) {
      console.warn('[AbrManager] No quality selected, skipping prefetch');
      return;
    }

    const qualityId = this.currentQuality.id;
    const playlist = this.variantPlaylists.get(qualityId);

    if (!playlist) {
      console.warn(`[AbrManager] No playlist for ${qualityId}, skipping prefetch`);
      return;
    }

    const config = this.configManager.getConfig();
    const prefetchCount = count || Math.ceil(config.prefetchWindowAhead / playlist.targetDuration);

    // Find current segment index
    const currentIndex = playlist.segments.findIndex(s => s.id === currentSegmentId);
    if (currentIndex === -1) {
      console.warn(`[AbrManager] Current segment ${currentSegmentId} not found`);
      return;
    }

    const segmentsToPrefetch: SegmentMetadata[] = [];

    for (let i = currentIndex + 1; i <= Math.min(playlist.segments.length - 1, currentIndex + prefetchCount); i++) {
      const seg = playlist.segments[i];
      const segmentKey = `${qualityId}:${seg.id}`;
      
      // Skip if already prefetched or cached
      if (this.prefetchedSegments.has(segmentKey)) continue;
      
      const cacheKey = `${this.movieId}:${qualityId}:${seg.id}`;
      if (this.cacheManager.has(cacheKey)) {
        this.prefetchedSegments.add(segmentKey);
        continue;
      }

      segmentsToPrefetch.push(seg);
    }

    if (segmentsToPrefetch.length === 0) {
      console.log(`[AbrManager] No segments to prefetch for ${qualityId}`);
      return;
    }

    console.log(`[AbrManager] Prefetching ${segmentsToPrefetch.length} segments in quality ${qualityId}`);

    // Prefetch in background (don't await)
    Promise.all(
      segmentsToPrefetch.map(async (seg) => {
        try {
          await this.fetchSegment(seg.id, qualityId);
          this.prefetchedSegments.add(`${qualityId}:${seg.id}`);
        } catch (error) {
          console.warn(`[AbrManager] Failed to prefetch segment ${seg.id}:`, error);
        }
      })
    ).then(() => {
      this.emit('prefetchComplete', segmentsToPrefetch.length, qualityId);
      console.log(`[AbrManager] Prefetch complete: ${segmentsToPrefetch.length} segments`);
    });
  }

  /**
   * Estimate best quality based on bandwidth and buffer status
   * Implements ABR algorithm with Strategy Pattern support
   */
  selectQuality(bufferStatus: BufferStatus): Quality | null {
    if (!this.masterPlaylist || this.masterPlaylist.qualities.length === 0) {
      return null;
    }

    // Use strategy if available
    if (this.qualityStrategy) {
      const qualities = this.masterPlaylist.qualities;
      const selected = this.qualityStrategy.selectQuality(
        qualities,
        this.currentQuality,
        this.estimatedBandwidth,
        bufferStatus
      );
      return selected;
    }

    // Fallback to existing ABR logic
    const config = this.configManager.getConfig();
    
    // Don't switch if already switching
    if (this.isQualitySwitching) {
      return this.currentQuality;
    }

    const qualities = [...this.masterPlaylist.qualities].sort((a, b) => a.bandwidth - b.bandwidth);
    const bufferRatio = bufferStatus.bufferAhead / config.bufferTargetDuration;

    // Switch down if buffer low
    if (bufferRatio < config.abrSwitchDownThreshold) {
      const currentIndex = qualities.findIndex(q => q.id === this.currentQuality?.id);
      if (currentIndex > 0) {
        console.log(`[AbrManager] Low buffer (${bufferRatio.toFixed(2)}), switching down`);
        return qualities[currentIndex - 1];
      }
    }

    // Switch up if buffer high and bandwidth allows
    if (bufferRatio > config.abrSwitchUpThreshold && this.estimatedBandwidth > 0) {
      const currentIndex = qualities.findIndex(q => q.id === this.currentQuality?.id);
      
      // Find highest quality that bandwidth can support (with 1.2x safety margin)
      for (let i = qualities.length - 1; i > currentIndex; i--) {
        if (qualities[i].bandwidth * 1.2 < this.estimatedBandwidth) {
          console.log(`[AbrManager] High buffer and bandwidth, switching up to ${qualities[i].id}`);
          return qualities[i];
        }
      }
    }

    // Stay at current quality
    return this.currentQuality;
  }

  /**
   * Update bandwidth estimation based on segment fetch
   * Uses strategy if available, otherwise falls back to default implementation
   */
  private updateBandwidthEstimate(bytes: number, latencyMs: number): void {
    // Use strategy if available
    if (this.bandwidthStrategy) {
      this.bandwidthStrategy.addSample(bytes, latencyMs);
      this.estimatedBandwidth = this.bandwidthStrategy.getEstimate();
      this.emit('bandwidthEstimated', this.estimatedBandwidth);
      return;
    }

    // Fallback to default implementation
    const { BITS_PER_BYTE, MS_TO_SECONDS } = APP_CONSTANTS.BANDWIDTH;
    const bandwidth = (bytes * BITS_PER_BYTE) / (latencyMs / MS_TO_SECONDS);
    
    this.bandwidthSamples.push(bandwidth);

    const config = this.configManager.getConfig();
    if (this.bandwidthSamples.length > config.bandwidthEstimationWindow) {
      this.bandwidthSamples.shift();
    }

    // Use exponential moving average
    const alpha = 0.3;
    const avgBandwidth = this.bandwidthSamples.reduce((a, b) => a + b, 0) / this.bandwidthSamples.length;
    
    this.estimatedBandwidth = this.estimatedBandwidth === 0
      ? avgBandwidth
      : alpha * avgBandwidth + (1 - alpha) * this.estimatedBandwidth;

    this.emit('bandwidthEstimated', this.estimatedBandwidth);
  }

  /**
   * Find segment at specific time
   */
  private findSegmentAtTime(time: number, qualityId: string): SegmentMetadata | null {
    const playlist = this.variantPlaylists.get(qualityId);
    if (!playlist) return null;

    return playlist.segments.find(seg => 
      time >= seg.timestamp && time < seg.timestamp + seg.duration
    ) || null;
  }

  getCurrentQuality(): Quality | null {
    return this.currentQuality;
  }

  getAvailableQualities(): Quality[] {
    return this.masterPlaylist?.qualities || [];
  }

  getPlaylist(qualityId: string): VariantPlaylist | undefined {
    return this.variantPlaylists.get(qualityId);
  }

  getInitSegment(qualityId: string): InitSegment | undefined {
    return this.initSegments.get(qualityId);
  }

  getEstimatedBandwidth(): number {
    return this.estimatedBandwidth;
  }

  getMovieId(): string {
    return this.movieId;
  }

  setBandwidthStrategy(strategy: IBandwidthEstimationStrategy): void {
    this.bandwidthStrategy = strategy;
    console.log('[AbrManager] Bandwidth estimation strategy updated');
  }

  setQualityStrategy(strategy: IQualitySelectionStrategy): void {
    this.qualityStrategy = strategy;
    console.log('[AbrManager] Quality selection strategy updated');
  }

  destroy(): void {
    console.log('[AbrManager] Disposing ABR manager');
    this.variantPlaylists.clear();
    this.initSegments.clear();
    this.prefetchedSegments.clear();
    this.bandwidthSamples = [];
    this.bandwidthStrategy = null;
    this.qualityStrategy = null;
  }
}
