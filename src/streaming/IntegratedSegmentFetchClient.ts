/**
 * Integrated Segment Fetch Logic
 * Handles P2P fetch with HTTP fallback, caching, and sequential buffer append
 */

import type {
  SegmentMetadata,
  FetchResult,
  FetchSource,
  WhoHasResponse,
} from './types';
import { SignalingClient } from './SignalingClient';
import { PeerManager } from './PeerManager';
import { CacheManager } from './CacheManager';
import { SegmentFetcher } from './SegmentFetcher';
import { ConfigManager } from './ConfigManager';
import { MseManager } from './MseManager';

export interface SegmentFetchRequest {
  segment: SegmentMetadata;
  priority: number;
  forSeek?: boolean;
}

export interface SegmentFetchStats {
  totalFetches: number;
  p2pFetches: number;
  httpFetches: number;
  cacheFetches: number;
  failedFetches: number;
  avgP2pLatency: number;
  avgHttpLatency: number;
}

/**
 * Integrated segment fetch coordinator with P2P + HTTP fallback
 */
export class IntegratedSegmentFetchClient {
  private movieId: string;
  private signalingClient: SignalingClient;
  private peerManager: PeerManager;
  private cacheManager: CacheManager;
  private segmentFetcher: SegmentFetcher;
  private mseManager: MseManager;
  private configManager: ConfigManager;

  // Segment append queue for sequential processing
  private appendQueue: Array<{
    segment: SegmentMetadata;
    data: ArrayBuffer;
    source: FetchSource;
  }> = [];
  private isAppending = false;
  private appendedSegments = new Set<string>(); // Track appended segment keys

  // Fetch statistics
  private stats: SegmentFetchStats = {
    totalFetches: 0,
    p2pFetches: 0,
    httpFetches: 0,
    cacheFetches: 0,
    failedFetches: 0,
    avgP2pLatency: 0,
    avgHttpLatency: 0,
  };

  // Active fetch tracking
  private activeFetches = new Map<string, Promise<FetchResult>>();

  constructor(
    movieId: string,
    signalingClient: SignalingClient,
    peerManager: PeerManager,
    cacheManager: CacheManager,
    segmentFetcher: SegmentFetcher,
    mseManager: MseManager,
    configManager: ConfigManager
  ) {
    this.movieId = movieId;
    this.signalingClient = signalingClient;
    this.peerManager = peerManager;
    this.cacheManager = cacheManager;
    this.segmentFetcher = segmentFetcher;
    this.mseManager = mseManager;
    this.configManager = configManager;
  }

  /**
   * Main entry point: Fetch segment with full P2P + HTTP fallback logic
   */
  async fetchSegment(request: SegmentFetchRequest): Promise<FetchResult> {
    const { segment, forSeek } = request;
    const segmentKey = this.getSegmentKey(segment);

    // Check if already fetching
    if (this.activeFetches.has(segmentKey)) {
      console.log(`[IntegratedFetch] Segment ${segmentKey} already being fetched`);
      return this.activeFetches.get(segmentKey)!;
    }

    // Start fetch
    const fetchPromise = this.executeSegmentFetch(segment, forSeek);
    this.activeFetches.set(segmentKey, fetchPromise);

    try {
      const result = await fetchPromise;
      return result;
    } finally {
      this.activeFetches.delete(segmentKey);
    }
  }

  /**
   * Execute segment fetch with complete strategy
   */
  private async executeSegmentFetch(
    segment: SegmentMetadata,
    forSeek?: boolean
  ): Promise<FetchResult> {
    const segmentKey = this.getSegmentKey(segment);
    const startTime = Date.now();

    this.stats.totalFetches++;

    console.log(
      `[IntegratedFetch] Fetching segment ${segmentKey}`,
      forSeek ? '(for seek)' : ''
    );

    // Step 1: Check cache
    const cached = this.cacheManager.getSegment(
      this.movieId,
      segment.qualityId,
      segment.id
    );

    if (cached) {
      console.log(`[IntegratedFetch] ✓ Cache hit for ${segmentKey}`);
      this.stats.cacheFetches++;

      // Queue for append
      await this.queueSegmentForAppend(segment, cached, 'cache');

      return {
        success: true,
        data: cached,
        source: 'cache',
        latency: Date.now() - startTime,
      };
    }

    // Step 2: Query signaling server for peers
    let peerIds: string[] = [];
    try {
      const whoHasResponse = await this.queryWhoHasSegment(segment);
      peerIds = whoHasResponse.peers || [];
      console.log(`[IntegratedFetch] WhoHas response: ${peerIds.length} peers have ${segmentKey}`);
    } catch (error) {
      console.warn(`[IntegratedFetch] WhoHas query failed for ${segmentKey}:`, error);
    }

    // Step 3: Try P2P fetch if peers available
    if (peerIds.length > 0) {
      const p2pResult = await this.fetchFromPeers(segment, peerIds);

      if (p2pResult.success && p2pResult.data) {
        console.log(`[IntegratedFetch] ✓ P2P success for ${segmentKey} from ${p2pResult.peerId}`);
        this.stats.p2pFetches++;
        this.updateP2pLatency(p2pResult.latency);

        // Cache the segment
        this.cacheSegment(segment, p2pResult.data);

        // Report success to signaling
        this.reportSegmentFetched(segment);

        // Queue for append
        await this.queueSegmentForAppend(segment, p2pResult.data, p2pResult.source);

        return p2pResult;
      }

      console.warn(`[IntegratedFetch] P2P failed for ${segmentKey}, falling back to HTTP`);
    }

    // Step 4: Fallback to HTTP from Seeder
    const httpResult = await this.fetchFromSeeder(segment);

    if (httpResult.success && httpResult.data) {
      console.log(`[IntegratedFetch] ✓ HTTP success for ${segmentKey}`);
      this.stats.httpFetches++;
      this.updateHttpLatency(httpResult.latency);

      // Cache the segment
      this.cacheSegment(segment, httpResult.data);

      // Report success to signaling
      this.reportSegmentFetched(segment);

      // Queue for append
      await this.queueSegmentForAppend(segment, httpResult.data, httpResult.source);

      return httpResult;
    }

    // All methods failed
    console.error(`[IntegratedFetch] ✗ All fetch methods failed for ${segmentKey}`);
    this.stats.failedFetches++;

    return {
      success: false,
      source: 'seeder',
      latency: Date.now() - startTime,
      error: new Error(`Failed to fetch segment ${segmentKey}`),
    };
  }

  /**
   * Query signaling server for peers that have the segment
   */
  private async queryWhoHasSegment(segment: SegmentMetadata): Promise<WhoHasResponse> {
    return this.signalingClient.whoHas(segment.qualityId, segment.id);
  }

  /**
   * Fetch from P2P peers with lazy connect and staggered requests
   */
  private async fetchFromPeers(
    segment: SegmentMetadata,
    peerIds: string[]
  ): Promise<FetchResult> {
    const segmentKey = this.getSegmentKey(segment);
    const config = this.configManager.getConfig();

    // Get scored peers for this segment
    const scoredPeers = this.peerManager.getBestPeersForSegment(
      segmentKey,
      config.maxActivePeers
    );

    if (scoredPeers.length === 0) {
      // Need to connect to peers first (lazy connect)
      for (const peerId of peerIds.slice(0, config.maxActivePeers)) {
        try {
          await this.peerManager.connectToPeer(peerId);
          
          // Update peer's available segments
          this.peerManager.updatePeerSegmentAvailability(peerId, [segmentKey]);
        } catch (error) {
          console.warn(`[IntegratedFetch] Failed to connect to peer ${peerId}:`, error);
        }
      }

      // Re-get scored peers after connections
      const newScoredPeers = this.peerManager.getBestPeersForSegment(
        segmentKey,
        config.maxActivePeers
      );
      
      if (newScoredPeers.length === 0) {
        return {
          success: false,
          source: 'peer',
          latency: 0,
          error: new Error('No connected peers available'),
        };
      }
    }

    // Staggered requests to top peers
    const topPeers = scoredPeers.slice(0, Math.min(3, scoredPeers.length));
    const fetchPromises: Promise<FetchResult>[] = [];

    for (let i = 0; i < topPeers.length; i++) {
      const peer = topPeers[i];
      const delay = i * config.staggeredRequestDelay;

      const promise = this.peerManager.fetchSegmentFromPeer(
        peer.peerId,
        segment,
        delay
      );

      fetchPromises.push(promise);
    }

    // Race: return first successful result
    try {
      const results = await Promise.allSettled(fetchPromises);

      // Find first successful result
      for (const result of results) {
        if (result.status === 'fulfilled' && result.value.success) {
          return result.value;
        }
      }

      // All failed
      return {
        success: false,
        source: 'peer',
        latency: 0,
        error: new Error('All peer fetches failed'),
      };
    } catch (error) {
      return {
        success: false,
        source: 'peer',
        latency: 0,
        error: error as Error,
      };
    }
  }

  /**
   * Fetch from HTTP Seeder (fallback)
   */
  private async fetchFromSeeder(segment: SegmentMetadata): Promise<FetchResult> {
    return this.segmentFetcher.fetchMediaSegment(segment, {
      preferPeer: false,
    });
  }

  /**
   * Cache segment locally
   */
  private cacheSegment(segment: SegmentMetadata, data: ArrayBuffer): void {
    // TTL configured in CacheManager constructor
    this.cacheManager.setSegment(this.movieId, segment.qualityId, segment.id, data);

    console.log(
      `[IntegratedFetch] Cached segment ${this.getSegmentKey(segment)} (${(data.byteLength / 1024).toFixed(1)} KB)`
    );
  }

  /**
   * Report successful segment fetch to signaling server
   */
  private reportSegmentFetched(segment: SegmentMetadata): void {
    this.signalingClient.reportSegmentAvailability([
      {
        qualityId: segment.qualityId,
        segmentId: segment.id,
      },
    ]);
  }

  /**
   * Queue segment for sequential append to buffer
   */
  private async queueSegmentForAppend(
    segment: SegmentMetadata,
    data: ArrayBuffer,
    source: FetchSource
  ): Promise<void> {
    const segmentKey = this.getSegmentKey(segment);

    // Check if already appended
    if (this.appendedSegments.has(segmentKey)) {
      console.log(`[IntegratedFetch] Segment ${segmentKey} already appended, skipping`);
      return;
    }

    // Add to queue
    this.appendQueue.push({ segment, data, source });

    // Sort queue by segment timestamp to ensure sequential append
    this.appendQueue.sort((a, b) => a.segment.timestamp - b.segment.timestamp);

    console.log(
      `[IntegratedFetch] Queued segment ${segmentKey} for append (queue size: ${this.appendQueue.length})`
    );

    // Process queue
    this.processAppendQueue();
  }

  /**
   * Process append queue sequentially to ensure continuous timeline
   */
  private async processAppendQueue(): Promise<void> {
    if (this.isAppending || this.appendQueue.length === 0) {
      return;
    }

    this.isAppending = true;

    while (this.appendQueue.length > 0) {
      const item = this.appendQueue.shift();
      if (!item) break;

      const segmentKey = this.getSegmentKey(item.segment);

      // Skip if already appended
      if (this.appendedSegments.has(segmentKey)) {
        continue;
      }

      try {
        console.log(
          `[IntegratedFetch] Appending segment ${segmentKey} from ${item.source}`
        );

        await this.mseManager.appendMediaSegment(item.data);

        this.appendedSegments.add(segmentKey);

        console.log(
          `[IntegratedFetch] ✓ Successfully appended segment ${segmentKey}`
        );
      } catch (error) {
        console.error(
          `[IntegratedFetch] ✗ Failed to append segment ${segmentKey}:`,
          error
        );

        // Re-queue at end if append failed (might need to wait)
        this.appendQueue.push(item);
        break; // Stop processing to avoid continuous errors
      }

      // Small delay between appends to avoid overwhelming MSE
      await this.sleep(10);
    }

    this.isAppending = false;

    // If there are still items, try again
    if (this.appendQueue.length > 0) {
      setTimeout(() => this.processAppendQueue(), 100);
    }
  }

  /**
   * Fetch segments around seek position
   */
  async fetchSegmentsAroundSeek(
    segments: SegmentMetadata[],
    seekTime: number
  ): Promise<void> {
    const config = this.configManager.getConfig();

    // Find segment at seek time
    const seekSegmentIndex = segments.findIndex((seg, idx) => {
      const nextSeg = segments[idx + 1];
      const segEnd = nextSeg ? nextSeg.timestamp : Infinity;
      return seekTime >= seg.timestamp && seekTime < segEnd;
    });

    if (seekSegmentIndex === -1) {
      console.warn('[IntegratedFetch] No segment found at seek time', seekTime);
      return;
    }

    // Calculate range to fetch (around seek position)
    const windowSize = Math.ceil(config.prefetchWindowAhead / 4); // ~5-7 segments
    const startIndex = Math.max(0, seekSegmentIndex - 2);
    const endIndex = Math.min(segments.length - 1, seekSegmentIndex + windowSize);

    console.log(
      `[IntegratedFetch] Fetching segments for seek to ${seekTime}s (${startIndex} to ${endIndex})`
    );

    // Fetch segments with priority (closer = higher priority)
    const fetchPromises: Promise<FetchResult>[] = [];

    for (let i = startIndex; i <= endIndex; i++) {
      const segment = segments[i];
      const distance = Math.abs(i - seekSegmentIndex);
      const priority = 100 - distance; // Higher number = higher priority

      fetchPromises.push(
        this.fetchSegment({
          segment,
          priority,
          forSeek: true,
        })
      );

      // Limit concurrent fetches
      if (fetchPromises.length >= config.maxConcurrentFetches) {
        await Promise.race(fetchPromises);
      }
    }

    // Wait for all to complete
    await Promise.allSettled(fetchPromises);

    console.log('[IntegratedFetch] Seek segment fetch complete');
  }

  /**
   * Prefetch segments ahead of playback
   */
  async prefetchSegmentsAhead(
    segments: SegmentMetadata[],
    currentTime: number
  ): Promise<void> {
    const config = this.configManager.getConfig();

    // Find current segment
    const currentSegmentIndex = segments.findIndex((seg, idx) => {
      const nextSeg = segments[idx + 1];
      const segEnd = nextSeg ? nextSeg.timestamp : Infinity;
      return currentTime >= seg.timestamp && currentTime < segEnd;
    });

    if (currentSegmentIndex === -1) return;

    // Calculate prefetch range
    const prefetchEndTime = currentTime + config.prefetchWindowAhead;
    const prefetchEndIndex = segments.findIndex((seg) => seg.timestamp > prefetchEndTime);
    const endIndex =
      prefetchEndIndex === -1 ? segments.length - 1 : prefetchEndIndex;

    console.log(
      `[IntegratedFetch] Prefetching ahead from segment ${currentSegmentIndex} to ${endIndex}`
    );

    // Fetch segments
    const fetchPromises: Promise<FetchResult>[] = [];

    for (let i = currentSegmentIndex; i <= endIndex; i++) {
      const segment = segments[i];
      const segmentKey = this.getSegmentKey(segment);

      // Skip if already cached or appended
      if (
        this.cacheManager.hasSegment(this.movieId, segment.qualityId, segment.id) ||
        this.appendedSegments.has(segmentKey)
      ) {
        continue;
      }

      const distance = i - currentSegmentIndex;
      const priority = 50 - distance; // Priority decreases with distance

      const promise = this.fetchSegment({
        segment,
        priority,
        forSeek: false,
      });

      fetchPromises.push(promise);

      // Limit concurrent fetches
      if (fetchPromises.length >= config.maxConcurrentFetches) {
        await Promise.race(fetchPromises);
      }
    }

    await Promise.allSettled(fetchPromises);
  }

  /**
   * Get segment key
   */
  private getSegmentKey(segment: SegmentMetadata): string {
    return `${segment.qualityId}:${segment.id}`;
  }

  /**
   * Update P2P latency stats
   */
  private updateP2pLatency(latency: number): void {
    const count = this.stats.p2pFetches;
    this.stats.avgP2pLatency =
      (this.stats.avgP2pLatency * (count - 1) + latency) / count;
  }

  /**
   * Update HTTP latency stats
   */
  private updateHttpLatency(latency: number): void {
    const count = this.stats.httpFetches;
    this.stats.avgHttpLatency =
      (this.stats.avgHttpLatency * (count - 1) + latency) / count;
  }

  /**
   * Get fetch statistics
   */
  getStats(): SegmentFetchStats {
    return { ...this.stats };
  }

  /**
   * Get P2P ratio
   */
  getP2pRatio(): number {
    const total = this.stats.p2pFetches + this.stats.httpFetches;
    return total > 0 ? this.stats.p2pFetches / total : 0;
  }

  /**
   * Clear append queue
   */
  clearAppendQueue(): void {
    this.appendQueue = [];
  }

  /**
   * Reset appended segments tracking
   */
  resetAppendedSegments(): void {
    this.appendedSegments.clear();
  }

  /**
   * Sleep utility
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Cleanup
   */
  dispose(): void {
    this.appendQueue = [];
    this.appendedSegments.clear();
    this.activeFetches.clear();
  }
}
