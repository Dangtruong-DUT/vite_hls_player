/**
 * Segment Fetcher
 * Fetches segments from peers or fallback to seeder/origin
 * Handles playlists and init segments
 */

import type {
  FetchSource,
  FetchResult,
  InitSegment,
  MasterPlaylist,
  VariantPlaylist,
  SegmentMetadata,
} from './types';
import { CacheManager } from './CacheManager';
import { ConfigManager } from './ConfigManager';

export interface FetchOptions {
  timeout?: number;
  retries?: number;
  priority?: number;
  preferPeer?: boolean;
}

export class SegmentFetcher {
  private cacheManager: CacheManager;
  private configManager: ConfigManager;
  private movieId: string;
  private activeFetches = new Map<string, AbortController>();

  constructor(
    movieId: string,
    cacheManager: CacheManager,
    configManager: ConfigManager
  ) {
    this.movieId = movieId;
    this.cacheManager = cacheManager;
    this.configManager = configManager;
  }

  /**
   * Fetch master playlist
   */
  async fetchMasterPlaylist(): Promise<MasterPlaylist> {
    // Check cache first
    const cached = this.cacheManager.getMasterPlaylist(this.movieId);
    if (cached) {
      console.log('[SegmentFetcher] Master playlist from cache');
      return cached;
    }

    // Fetch from seeder
    const config = this.configManager.getConfig();
    const url = `${config.baseUrl}/streams/movies/${this.movieId}/master.m3u8`;

    try {
      const response = await this.fetchWithTimeout(url, config.fetchTimeout);
      const text = await response.text();
      const playlist = this.parseMasterPlaylist(text, url);

      // Cache it (TTL configured in CacheManager constructor)
      this.cacheManager.setMasterPlaylist(this.movieId, playlist);

      return playlist;
    } catch (error) {
      throw new Error(`Failed to fetch master playlist: ${error}`);
    }
  }

  /**
   * Fetch variant playlist for specific quality
   */
  async fetchVariantPlaylist(qualityId: string): Promise<VariantPlaylist> {
    // Check cache first
    const cached = this.cacheManager.getVariantPlaylist(this.movieId, qualityId);
    if (cached) {
      console.log(`[SegmentFetcher] Variant playlist ${qualityId} from cache`);
      return cached;
    }

    // Fetch from seeder
    const config = this.configManager.getConfig();
    const url = `${config.baseUrl}/streams/movies/${this.movieId}/${qualityId}/playlist.m3u8`;

    try {
      const response = await this.fetchWithTimeout(url, config.fetchTimeout);
      const text = await response.text();
      const playlist = this.parseVariantPlaylist(text, qualityId);

      // Cache it (TTL configured in CacheManager constructor)
      this.cacheManager.setVariantPlaylist(this.movieId, qualityId, playlist);

      return playlist;
    } catch (error) {
      throw new Error(`Failed to fetch variant playlist for ${qualityId}: ${error}`);
    }
  }

  /**
   * Fetch init segment
   */
  async fetchInitSegment(qualityId: string, ext = 'mp4'): Promise<InitSegment> {
    // Check cache first
    const cached = this.cacheManager.getInitSegment(this.movieId, qualityId);
    if (cached) {
      console.log(`[SegmentFetcher] Init segment ${qualityId} from cache`);
      return cached;
    }

    // Fetch from seeder
    const config = this.configManager.getConfig();
    const url = `${config.baseUrl}/streams/movies/${this.movieId}/${qualityId}/init.${ext}`;

    try {
      const response = await this.fetchWithTimeout(url, config.fetchTimeout);
      const data = await response.arrayBuffer();

      const initSegment: InitSegment = {
        qualityId,
        data,
        url,
      };

      // Cache it (TTL configured in CacheManager constructor)
      this.cacheManager.setInitSegment(this.movieId, qualityId, initSegment);

      return initSegment;
    } catch (error) {
      throw new Error(`Failed to fetch init segment for ${qualityId}: ${error}`);
    }
  }

  /**
   * Fetch media segment - tries peer first, then fallback to seeder
   */
  async fetchMediaSegment(
    segment: SegmentMetadata,
    options: FetchOptions = {}
  ): Promise<FetchResult> {
    const startTime = Date.now();
    const qualityId = segment.qualityId;
    const segmentId = segment.id;

    // Check cache first
    const cached = this.cacheManager.getSegment(this.movieId, qualityId, segmentId);
    if (cached) {
      return {
        success: true,
        data: cached,
        source: 'cache' as FetchSource,
        latency: Date.now() - startTime,
      };
    }

    // Try peer if requested (will be implemented by PeerManager)
    if (options.preferPeer) {
      // Placeholder for peer fetch - will be coordinated by PeerManager
      // For now, fall through to HTTP
    }

    // Fallback to HTTP from seeder
    return this.fetchFromSeeder(segment, options);
  }

  /**
   * Fetch segment from seeder via HTTP
   */
  private async fetchFromSeeder(
    segment: SegmentMetadata,
    options: FetchOptions = {}
  ): Promise<FetchResult> {
    const startTime = Date.now();
    const config = this.configManager.getConfig();
    const timeout = options.timeout ?? config.fetchTimeout;
    const maxRetries = options.retries ?? config.maxRetries;

    const url = `${config.baseUrl}/streams/movies/${this.movieId}/${segment.qualityId}/${segment.id}`;
    const fetchKey = `${segment.qualityId}:${segment.id}`;

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        // Create abort controller
        const controller = new AbortController();
        this.activeFetches.set(fetchKey, controller);

        const response = await this.fetchWithTimeout(url, timeout, controller.signal);
        const data = await response.arrayBuffer();

        // Remove from active fetches
        this.activeFetches.delete(fetchKey);

        // Cache the segment (TTL configured in CacheManager constructor)
        this.cacheManager.setSegment(this.movieId, segment.qualityId, segment.id, data);

        return {
          success: true,
          data,
          source: 'seeder' as FetchSource,
          latency: Date.now() - startTime,
        };
      } catch (error) {
        lastError = error as Error;
        console.warn(
          `[SegmentFetcher] Attempt ${attempt + 1}/${maxRetries + 1} failed for segment ${segment.id}:`,
          error
        );

        // Exponential backoff
        if (attempt < maxRetries) {
          const delay = config.retryDelayBase * Math.pow(2, attempt);
          await this.sleep(delay);
        }
      }
    }

    // All retries failed
    this.activeFetches.delete(fetchKey);

    return {
      success: false,
      source: 'seeder' as FetchSource,
      latency: Date.now() - startTime,
      error: lastError ?? new Error('Unknown error'),
    };
  }

  /**
   * Batch fetch multiple segments
   */
  async fetchSegments(
    segments: SegmentMetadata[],
    options: FetchOptions = {}
  ): Promise<Map<string, FetchResult>> {
    const results = new Map<string, FetchResult>();
    const config = this.configManager.getConfig();
    const maxConcurrent = config.maxConcurrentFetches;

    // Batch fetches with concurrency limit
    for (let i = 0; i < segments.length; i += maxConcurrent) {
      const batch = segments.slice(i, i + maxConcurrent);
      const promises = batch.map(seg => this.fetchMediaSegment(seg, options));
      const batchResults = await Promise.all(promises);

      batchResults.forEach((result, index) => {
        results.set(batch[index].id, result);
      });
    }

    return results;
  }

  /**
   * Cancel ongoing fetch
   */
  cancelFetch(qualityId: string, segmentId: string): void {
    const fetchKey = `${qualityId}:${segmentId}`;
    const controller = this.activeFetches.get(fetchKey);
    if (controller) {
      controller.abort();
      this.activeFetches.delete(fetchKey);
    }
  }

  /**
   * Cancel all ongoing fetches
   */
  cancelAllFetches(): void {
    this.activeFetches.forEach(controller => controller.abort());
    this.activeFetches.clear();
  }

  /**
   * Parse master playlist (simplified m3u8 parser)
   */
  private parseMasterPlaylist(content: string, _baseUrl: string): MasterPlaylist {
    const lines = content.split('\n').map(l => l.trim());
    const qualities: MasterPlaylist['qualities'] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (line.startsWith('#EXT-X-STREAM-INF:')) {
        const attrs = this.parseAttributes(line);
        const urlLine = lines[i + 1];

        if (urlLine && !urlLine.startsWith('#')) {
          // Extract quality ID from URL (e.g., 720p from 720p/playlist.m3u8)
          const match = urlLine.match(/(\w+)\/playlist\.m3u8/);
          const qualityId = match ? match[1] : `quality_${qualities.length}`;

          const resolution = attrs['RESOLUTION']?.split('x') || ['1920', '1080'];
          
          qualities.push({
            id: qualityId,
            bandwidth: parseInt(attrs['BANDWIDTH'] || '0', 10),
            width: parseInt(resolution[0], 10),
            height: parseInt(resolution[1], 10),
            codecs: attrs['CODECS'] || 'avc1.64001f,mp4a.40.2',
            frameRate: attrs['FRAME-RATE'] ? parseFloat(attrs['FRAME-RATE']) : undefined,
          });
        }
      }
    }

    return {
      qualities,
      defaultQualityId: qualities[0]?.id,
    };
  }

  /**
   * Parse variant playlist
   */
  private parseVariantPlaylist(
    content: string,
    qualityId: string
  ): VariantPlaylist {
    const lines = content.split('\n').map(l => l.trim());
    const segments: SegmentMetadata[] = [];
    let targetDuration = 0;
    let currentTime = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (line.startsWith('#EXT-X-TARGETDURATION:')) {
        targetDuration = parseFloat(line.split(':')[1]);
      } else if (line.startsWith('#EXTINF:')) {
        const duration = parseFloat(line.split(':')[1].split(',')[0]);
        const urlLine = lines[i + 1];

        if (urlLine && !urlLine.startsWith('#')) {
          // Extract segment ID from filename (e.g., "seg_0001.m4s" or "123.m4s")
          let segmentId: string;
          const newFormatMatch = urlLine.match(/(seg_\d+\.m4s)/);
          const oldFormatMatch = urlLine.match(/(\d+)\.m4s/);
          if (newFormatMatch) {
            segmentId = newFormatMatch[1];
          } else if (oldFormatMatch) {
            const numId = parseInt(oldFormatMatch[1], 10);
            segmentId = `seg_${String(numId).padStart(4, '0')}.m4s`;
          } else {
            segmentId = `seg_${String(segments.length).padStart(4, '0')}.m4s`;
          }
          segments.push({
            id: segmentId,
            movieId: this.movieId,
            qualityId,
            duration,
            timestamp: currentTime
          });

          currentTime += duration;
        }
      }
    }

    return {
      qualityId,
      segments,
      targetDuration,
      totalDuration: currentTime,
    };
  }

  /**
   * Parse m3u8 attributes
   */
  private parseAttributes(line: string): Record<string, string> {
    const attrs: Record<string, string> = {};
    const attrString = line.split(':')[1];
    const regex = /([A-Z-]+)=("([^"]*)"|([^,]*))/g;
    let match;

    while ((match = regex.exec(attrString)) !== null) {
      const key = match[1];
      const value = match[3] || match[4];
      attrs[key] = value;
    }

    return attrs;
  }

  /**
   * Fetch with timeout
   */
  private async fetchWithTimeout(
    url: string,
    timeout: number,
    signal?: AbortSignal
  ): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(url, {
        signal: signal || controller.signal,
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      return response;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Sleep utility
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Get active fetch count
   */
  getActiveFetchCount(): number {
    return this.activeFetches.size;
  }

  /**
   * Check if segment is being fetched
   */
  isFetching(qualityId: string, segmentId: number): boolean {
    const fetchKey = `${qualityId}:${segmentId}`;
    return this.activeFetches.has(fetchKey);
  }
}
