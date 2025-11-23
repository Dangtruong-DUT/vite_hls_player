import type { 
  CacheStats, 
  InitSegment, 
  MasterPlaylist, 
  VariantPlaylist,
  SegmentMetadata 
} from './types';
import type { ICacheManager, ICacheEvictionStrategy, ICacheEntry } from './interfaces/ICacheManager';
import { LRUEvictionStrategy } from './strategies/CacheEvictionStrategies';
import { APP_CONSTANTS, type ConfigManager } from './ConfigManager';

export type CacheableData = ArrayBuffer | InitSegment | MasterPlaylist | VariantPlaylist;

export interface CacheConfig {
  maxSize: number; // Total cache size in bytes
  segmentTTL: number; // Media segment TTL in ms
  initTTL: number; // Init segment TTL (long)
  playlistTTL: number; // Playlist TTL (long)
  hotCacheProtection: boolean; // Protect init + playlist from eviction
}

/**
 * Cache Manager with hot cache protection and Seeder fallback
 * Implements ICacheManager interface
 */
export class CacheManager implements ICacheManager {
  // Cache storage
  private cache = new Map<string, ICacheEntry<CacheableData>>();
  private accessOrder: string[] = []; // LRU tracking
  private hotCache = new Set<string>(); // Protected from eviction
  
  // Time to segment ID mapping (per quality)
  private segmentTimeMaps = new Map<string, SegmentMetadata[]>(); // key: `${movieId}:${qualityId}`
  
  // Configuration
  private config: CacheConfig;
  private configManager: ConfigManager;
  private currentSize = 0;
  
  // Eviction strategy (Strategy Pattern)
  private evictionStrategy: ICacheEvictionStrategy;
  
  // Statistics
  private stats: CacheStats = {
    hits: 0,
    misses: 0,
    evictions: 0,
    currentSize: 0,
    maxSize: 0,
    itemCount: 0,
  };

  // Callback for segment eviction/deletion - notify signaling server
  private onSegmentRemoved?: (movieId: string, qualityId: string, segmentId: string) => void;

  constructor(
    configManager: ConfigManager,
    config?: Partial<CacheConfig & { 
      evictionStrategy?: ICacheEvictionStrategy;
      onSegmentRemoved?: (movieId: string, qualityId: string, segmentId: string) => void;
    }>
  ) {
    this.configManager = configManager;
    this.config = {
      maxSize: config?.maxSize || APP_CONSTANTS.CACHE_DEFAULTS.MAX_SIZE,
      segmentTTL: config?.segmentTTL || APP_CONSTANTS.CACHE_DEFAULTS.SEGMENT_TTL,
      initTTL: config?.initTTL || APP_CONSTANTS.CACHE_DEFAULTS.INIT_TTL,
      playlistTTL: config?.playlistTTL || APP_CONSTANTS.CACHE_DEFAULTS.PLAYLIST_TTL,
      hotCacheProtection: config?.hotCacheProtection ?? APP_CONSTANTS.CACHE_DEFAULTS.HOT_CACHE_PROTECTION,
    };

    // Default to LRU eviction strategy
    this.evictionStrategy = config?.evictionStrategy || new LRUEvictionStrategy();
    this.onSegmentRemoved = config?.onSegmentRemoved;

    this.stats.maxSize = this.config.maxSize;

    // Auto cleanup expired entries
    setInterval(() => this.cleanExpired(), APP_CONSTANTS.TIMING.CACHE_CLEANUP_INTERVAL);
  }

  /**
   * Set eviction strategy (Strategy Pattern - OCP)
   */
  setEvictionStrategy(strategy: ICacheEvictionStrategy): void {
    this.evictionStrategy = strategy;
  }

  /**
   * Get time mapper for segment lookup
   */
  getTimeMapper() {
    return {
      buildTimeMap: this.buildSegmentTimeMap.bind(this),
      findSegmentAtTime: this.findSegmentIdAtTime.bind(this),
      getSegmentsInRange: this.getSegmentIdsInTimeRange.bind(this),
      clearTimeMap: this.clearSegmentTimeMap.bind(this),
    };
  }

  // ============ Core Cache Operations ============

  set(key: string, data: CacheableData, ttl: number, isHot = false): void {
    const size = this.calculateSize(data);

    if (!isHot) {
      while (this.currentSize + size > this.config.maxSize && this.cache.size > 0) {
        this.evict();
      }
    }

    const existing = this.cache.get(key);
    if (existing) {
      this.currentSize -= existing.size;
      this.removeFromAccessOrder(key);
    }

    const entry: ICacheEntry<CacheableData> = {
      key,
      data,
      size,
      timestamp: Date.now(),
      ttl,
      accessCount: 0,
      lastAccessed: Date.now(),
    };

    this.cache.set(key, entry);
    
    // Mark as hot cache if needed (protected from eviction)
    if (isHot && this.config.hotCacheProtection) {
      this.hotCache.add(key);
    } else {
      this.accessOrder.push(key);
    }
    
    this.currentSize += size;
    this.updateStats();
  }

  /**
   * Get data from cache
   */
  get<T extends CacheableData = CacheableData>(key: string): T | null {
    const entry = this.cache.get(key);

    if (!entry) {
      this.stats.misses++;
      return null;
    }

    // Check TTL
    const now = Date.now();
    if (now - entry.timestamp > entry.ttl) {
      this.delete(key);
      this.stats.misses++;
      return null;
    }

    // Update access info
    entry.accessCount++;
    entry.lastAccessed = now;

    // Update LRU order (skip if hot cache)
    if (!this.hotCache.has(key)) {
      this.removeFromAccessOrder(key);
      this.accessOrder.push(key);
    }

    this.stats.hits++;
    return entry.data as T;
  }

  /**
   * Check if key exists and is valid
   */
  has(key: string): boolean {
    const entry = this.cache.get(key);
    if (!entry) return false;

    // Check TTL
    const now = Date.now();
    if (now - entry.timestamp > entry.ttl) {
      this.delete(key);
      return false;
    }

    return true;
  }

  /**
   * Delete specific key
   */
  delete(key: string): boolean {
    const entry = this.cache.get(key);
    if (!entry) return false;

    // Check if this is a media segment and notify if needed
    this.notifySegmentRemoval(key);

    this.cache.delete(key);
    this.hotCache.delete(key);
    this.currentSize -= entry.size;
    this.removeFromAccessOrder(key);
    this.updateStats();

    return true;
  }

  clear(): void {
    this.cache.clear();
    this.hotCache.clear();
    this.accessOrder = [];
    this.segmentTimeMaps.clear();
    this.currentSize = 0;
    this.updateStats();
    console.log('[CacheManager] Cache cleared');
  }

  // ============ Segment Operations (với key: streamId/movieId, qualityId, segmentId) ============

  /**
   * Store media segment (LRU + TTL, có thể bị evict)
   */
  setSegment(
    movieId: string,
    qualityId: string,
    segmentId: string,
    data: ArrayBuffer
  ): void {
    const key = this.getSegmentKey(movieId, qualityId, segmentId);
    this.set(key, data, this.config.segmentTTL, false); // NOT hot cache
  }

  /**
   * Get media segment
   */
  getSegment(movieId: string, qualityId: string, segmentId: string): ArrayBuffer | null {
    const key = this.getSegmentKey(movieId, qualityId, segmentId);
    return this.get<ArrayBuffer>(key);
  }

  /**
   * Check if segment exists
   */
  hasSegment(movieId: string, qualityId: string, segmentId: string): boolean {
    const key = this.getSegmentKey(movieId, qualityId, segmentId);
    return this.has(key);
  }

  /**
   * Get segments in range (for seek optimization)
   * Note: With string IDs, caller should provide array of segmentIds
   */
  getSegmentsInRange(
    movieId: string,
    qualityId: string,
    segmentIds: string[]
  ): Map<string, ArrayBuffer> {
    const segments = new Map<string, ArrayBuffer>();

    for (const segmentId of segmentIds) {
      const data = this.getSegment(movieId, qualityId, segmentId);
      if (data) {
        segments.set(segmentId, data);
      }
    }

    return segments;
  }

  // ============ Init Segment Operations (HOT CACHE - ưu tiên giữ) ============

  /**
   * Store init segment (HOT CACHE - never evict)
   */
  setInitSegment(movieId: string, qualityId: string, data: InitSegment): void {
    const key = this.getInitSegmentKey(movieId, qualityId);
    this.set(key, data, this.config.initTTL, true); // HOT cache
  }

  /**
   * Get init segment
   */
  getInitSegment(movieId: string, qualityId: string): InitSegment | null {
    const key = this.getInitSegmentKey(movieId, qualityId);
    return this.get<InitSegment>(key);
  }

  /**
   * Check if init segment exists
   */
  hasInitSegment(movieId: string, qualityId: string): boolean {
    const key = this.getInitSegmentKey(movieId, qualityId);
    return this.has(key);
  }

  // ============ Playlist Operations (HOT CACHE - ưu tiên giữ) ============

  /**
   * Store master playlist (HOT CACHE - never evict)
   */
  setMasterPlaylist(movieId: string, data: MasterPlaylist): void {
    const key = this.getMasterPlaylistKey(movieId);
    this.set(key, data, this.config.playlistTTL, true); // HOT cache
  }

  /**
   * Get master playlist
   */
  getMasterPlaylist(movieId: string): MasterPlaylist | null {
    const key = this.getMasterPlaylistKey(movieId);
    return this.get<MasterPlaylist>(key);
  }

  /**
   * Store variant playlist (HOT CACHE - never evict)
   */
  setVariantPlaylist(movieId: string, qualityId: string, data: VariantPlaylist): void {
    const key = this.getVariantPlaylistKey(movieId, qualityId);
    this.set(key, data, this.config.playlistTTL, true); // HOT cache

    // Also store segment time mapping for seek support
    this.storeSegmentTimeMap(movieId, qualityId, data.segments);
  }

  /**
   * Get variant playlist
   */
  getVariantPlaylist(movieId: string, qualityId: string): VariantPlaylist | null {
    const key = this.getVariantPlaylistKey(movieId, qualityId);
    return this.get<VariantPlaylist>(key);
  }

  // ============ Time → SegmentId Mapping (cho seek support) ============

  /**
   * Build segment time map (ISegmentTimeMapper interface)
   */
  buildSegmentTimeMap(
    movieId: string,
    qualityId: string,
    segments: Array<{ id: string; timestamp: number; duration: number }>
  ): void {
    const mapKey = `${movieId}:${qualityId}`;
    const metadata: SegmentMetadata[] = segments.map(s => ({
      id: s.id,
      movieId,
      qualityId,
      timestamp: s.timestamp,
      duration: s.duration,
    }));
    this.segmentTimeMaps.set(mapKey, metadata);
    console.log(`[CacheManager] Built time map for ${mapKey} (${segments.length} segments)`);
  }

  /**
   * Find segment ID at time (ISegmentTimeMapper interface)
   */
  findSegmentIdAtTime(movieId: string, qualityId: string, time: number): string | null {
    return this.mapTimeToSegmentId(movieId, qualityId, time);
  }

  /**
   * Get segment IDs in time range (ISegmentTimeMapper interface)
   */
  getSegmentIdsInTimeRange(
    movieId: string,
    qualityId: string,
    startTime: number,
    endTime: number
  ): string[] {
    const mapKey = `${movieId}:${qualityId}`;
    const segments = this.segmentTimeMaps.get(mapKey);
    
    if (!segments) return [];
    
    return segments
      .filter(s => {
        const segEnd = s.timestamp + s.duration;
        return s.timestamp < endTime && segEnd > startTime;
      })
      .map(s => s.id);
  }

  /**
   * Clear time map (ISegmentTimeMapper interface)
   */
  clearSegmentTimeMap(movieId: string, qualityId?: string): void {
    if (qualityId) {
      const mapKey = `${movieId}:${qualityId}`;
      this.segmentTimeMaps.delete(mapKey);
      console.log(`[CacheManager] Cleared time map for ${mapKey}`);
    } else {
      // Clear all maps for this movieId
      const keysToDelete: string[] = [];
      this.segmentTimeMaps.forEach((_, key) => {
        if (key.startsWith(`${movieId}:`)) {
          keysToDelete.push(key);
        }
      });
      keysToDelete.forEach(key => this.segmentTimeMaps.delete(key));
      console.log(`[CacheManager] Cleared ${keysToDelete.length} time maps for movie ${movieId}`);
    }
  }

  /**
   * Store segment time mapping (from playlist)
   */
  private storeSegmentTimeMap(
    movieId: string,
    qualityId: string,
    segments: SegmentMetadata[]
  ): void {
    const mapKey = `${movieId}:${qualityId}`;
    this.segmentTimeMaps.set(mapKey, segments);
    console.log(`[CacheManager] Stored time map for ${mapKey} (${segments.length} segments)`);
  }

  /**
   * Map time → segmentId
   */
  mapTimeToSegmentId(movieId: string, qualityId: string, time: number): string | null {
    const mapKey = `${movieId}:${qualityId}`;
    const segments = this.segmentTimeMaps.get(mapKey);

    if (!segments) {
      console.warn(`[CacheManager] No time map for ${mapKey}`);
      return null;
    }

    // Binary search or linear search
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      const nextSegment = segments[i + 1];

      const segmentStart = segment.timestamp;
      const segmentEnd = nextSegment ? nextSegment.timestamp : Infinity;

      if (time >= segmentStart && time < segmentEnd) {
        return segment.id;
      }
    }

    return null;
  }

  /**
   * Get segment metadata at time
   */
  getSegmentAtTime(movieId: string, qualityId: string, time: number): SegmentMetadata | null {
    const mapKey = `${movieId}:${qualityId}`;
    const segments = this.segmentTimeMaps.get(mapKey);

    if (!segments) return null;

    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      const nextSegment = segments[i + 1];

      const segmentStart = segment.timestamp;
      const segmentEnd = nextSegment ? nextSegment.timestamp : Infinity;

      if (time >= segmentStart && time < segmentEnd) {
        return segment;
      }
    }

    return null;
  }

  /**
   * Get segments around seek position (for prefetch)
   */
  getSegmentsAroundTime(
    movieId: string,
    qualityId: string,
    time: number,
    before: number = 5,
    after: number = 10
  ): SegmentMetadata[] {
    const mapKey = `${movieId}:${qualityId}`;
    const segments = this.segmentTimeMaps.get(mapKey);

    if (!segments) return [];

    // Find segment at time
    const segmentAtTime = this.getSegmentAtTime(movieId, qualityId, time);
    if (!segmentAtTime) return [];

    const index = segments.indexOf(segmentAtTime);
    const startIndex = Math.max(0, index - before);
    const endIndex = Math.min(segments.length - 1, index + after);

    return segments.slice(startIndex, endIndex + 1);
  }

  /**
   * Fetch từ Seeder với fallback
   */
  async fetchFromSeeder(endpoint: string): Promise<ArrayBuffer> {
    try {
      const response = await fetch(endpoint);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      return await response.arrayBuffer();
    } catch (error) {
      console.error(`[CacheManager] Fetch failed from ${endpoint}:`, error);
      throw error;
    }
  }

  // ============ LRU Eviction (skip hot cache) ============

  /**
   * Evict item using eviction strategy
   */
  private evict(): void {
    const keyToEvict = this.evictionStrategy.selectEvictionCandidate(
      this.cache,
      this.hotCache,
      0
    );

    if (!keyToEvict) {
      console.warn('[CacheManager] No eviction candidate found');
      return;
    }

    const entry = this.cache.get(keyToEvict);
    if (entry) {
      // Notify before removing the segment
      this.notifySegmentRemoval(keyToEvict);

      this.cache.delete(keyToEvict);
      this.currentSize -= entry.size;
      this.removeFromAccessOrder(keyToEvict);
      this.stats.evictions++;
      
      console.log(`[CacheManager] Evicted ${keyToEvict} (${this.formatSize(entry.size)})`);
    }
  }

  /**
   * Remove key from access order
   */
  private removeFromAccessOrder(key: string): void {
    const index = this.accessOrder.indexOf(key);
    if (index > -1) {
      this.accessOrder.splice(index, 1);
    }
  }

  /**
   * Notify signaling server when a media segment is removed from cache
   * This ensures the signaling server has accurate info about available segments
   */
  private notifySegmentRemoval(key: string): void {
    // Only notify for media segments (format: "segment:movieId:qualityId:segmentId")
    if (!key.startsWith('segment:') || !this.onSegmentRemoved) {
      return;
    }

    try {
      const parts = key.split(':');
      if (parts.length === 4) {
        const [, movieId, qualityId, segmentId] = parts;
        this.onSegmentRemoved(movieId, qualityId, segmentId);
        console.log(`[CacheManager] Notified removal of segment: ${movieId}/${qualityId}/${segmentId}`);
      }
    } catch (error) {
      console.warn('[CacheManager] Failed to notify segment removal:', error);
    }
  }

  // ============ Utilities ============

  /**
   * Calculate size of data
   */
  private calculateSize(data: CacheableData): number {
    if (data instanceof ArrayBuffer) {
      return data.byteLength;
    }
    
    if ('data' in data && data.data instanceof ArrayBuffer) {
      // InitSegment
      return data.data.byteLength;
    }

    // For playlists, estimate size
    return JSON.stringify(data).length * 2;
  }

  /**
   * Update statistics
   */
  private updateStats(): void {
    this.stats.currentSize = this.currentSize;
    this.stats.itemCount = this.cache.size;
  }

  /**
   * Clean expired entries
   */
  cleanExpired(): number {
    const now = Date.now();
    const keysToDelete: string[] = [];

    this.cache.forEach((entry, key) => {
      // Skip hot cache items (protected)
      if (this.hotCache.has(key)) return;
      
      if (now - entry.timestamp > entry.ttl) {
        keysToDelete.push(key);
      }
    });

    // Delete will handle notification for each segment
    keysToDelete.forEach(key => this.delete(key));
    
    if (keysToDelete.length > 0) {
      console.log(`[CacheManager] Cleaned ${keysToDelete.length} expired entries`);
    }
    
    return keysToDelete.length;
  }

  /**
   * Format size for logging
   */
  private formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  }

  // ============ Key Generation ============

  private getSegmentKey(movieId: string, qualityId: string, segmentId: string): string {
    return `segment:${movieId}:${qualityId}:${segmentId}`;
  }

  private getInitSegmentKey(movieId: string, qualityId: string): string {
    return `init:${movieId}:${qualityId}`;
  }

  private getMasterPlaylistKey(movieId: string): string {
    return `master:${movieId}`;
  }

  private getVariantPlaylistKey(movieId: string, qualityId: string): string {
    return `variant:${movieId}:${qualityId}`;
  }

  // ============ Statistics & Debug ============

  /**
   * Get current cache size
   */
  getCurrentSize(): number {
    return this.currentSize;
  }

  /**
   * Get item count
   */
  getItemCount(): number {
    return this.cache.size;
  }

  /**
   * Get cache statistics
   */
  getStats(): CacheStats & { hitRate: number } {
    return { 
      ...this.stats,
      hitRate: this.getHitRate()
    };
  }

  /**
   * Get hit rate
   */
  getHitRate(): number {
    const total = this.stats.hits + this.stats.misses;
    return total > 0 ? this.stats.hits / total : 0;
  }

  /**
   * Get cache usage percentage
   */
  getUsagePercentage(): number {
    return (this.currentSize / this.config.maxSize) * 100;
  }

  /**
   * Get all cached segment IDs for a quality
   */
  getCachedSegmentIds(movieId: string, qualityId: string): number[] {
    const ids: number[] = [];
    const prefix = `segment:${movieId}:${qualityId}:`;

    this.cache.forEach((_, key) => {
      if (key.startsWith(prefix)) {
        const segmentId = parseInt(key.split(':')[3], 10);
        if (!isNaN(segmentId)) {
          ids.push(segmentId);
        }
      }
    });

    return ids.sort((a, b) => a - b);
  }

  /**
   * Get hot cache keys
   */
  getHotCacheKeys(): string[] {
    return Array.from(this.hotCache);
  }

  /**
   * Get cache breakdown
   */
  getCacheBreakdown(): {
    segments: number;
    initSegments: number;
    playlists: number;
    total: number;
    hotCacheCount: number;
  } {
    let segments = 0;
    let initSegments = 0;
    let playlists = 0;

    this.cache.forEach((_, key) => {
      if (key.startsWith('segment:')) segments++;
      else if (key.startsWith('init:')) initSegments++;
      else if (key.startsWith('master:') || key.startsWith('variant:')) playlists++;
    });

    return {
      segments,
      initSegments,
      playlists,
      total: this.cache.size,
      hotCacheCount: this.hotCache.size,
    };
  }

  /**
   * Set max cache size
   */
  setMaxSize(maxSize: number): void {
    this.config.maxSize = maxSize;
    this.stats.maxSize = maxSize;

    // Evict if necessary
    while (this.currentSize > this.config.maxSize && this.cache.size > 0) {
      this.evict();
    }
  }
}
