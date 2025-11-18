/**
 * Cache Manager v2 - Client-Side
 * Refactored to follow SOLID principles
 * 
 * Features:
 * - Lưu segment, init segment, playlist theo key (streamId, qualityId, segmentId)
 * - Init + playlist luôn ưu tiên giữ (hot cache - never evict)
 * - Media segment theo LRU + TTL (auto evict)
 * - Lookup nhanh cho fetch/append
 * - Map time → segmentId cho seek support
 * - Biết endpoint fallback Seeder
 */

import type { 
  CacheStats, 
  InitSegment, 
  MasterPlaylist, 
  VariantPlaylist,
  SegmentMetadata 
} from './types';
import type { ICacheManager, ICacheEvictionStrategy, ICacheEntry } from './interfaces/ICacheManager';
import { LRUEvictionStrategy } from './strategies/CacheEvictionStrategies';

export type CacheableData = ArrayBuffer | InitSegment | MasterPlaylist | VariantPlaylist;

export interface SeederEndpoints {
  masterPlaylist: (movieId: string) => string;
  variantPlaylist: (movieId: string, qualityId: string) => string;
  initSegment: (movieId: string, qualityId: string) => string;
  mediaSegment: (movieId: string, qualityId: string, segmentId: string) => string;
}

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

  // Seeder endpoints
  private seederEndpoints: SeederEndpoints = {
    masterPlaylist: (movieId) => `/api/v1/streams/movies/${movieId}/master.m3u8`,
    variantPlaylist: (movieId, qualityId) => `/api/v1/streams/movies/${movieId}/${qualityId}/playlist.m3u8`,
    initSegment: (movieId, qualityId) => `/api/v1/streams/movies/${movieId}/${qualityId}/init.mp4`,
    mediaSegment: (movieId, qualityId, segmentId) => `/api/v1/streams/movies/${movieId}/${qualityId}/${segmentId}`,
  };

  constructor(config?: Partial<CacheConfig & { evictionStrategy?: ICacheEvictionStrategy }>) {
    this.config = {
      maxSize: config?.maxSize || 500 * 1024 * 1024, // 500MB default
      segmentTTL: config?.segmentTTL || 30 * 60 * 1000, // 30 minutes
      initTTL: config?.initTTL || 24 * 60 * 60 * 1000, // 24 hours
      playlistTTL: config?.playlistTTL || 60 * 60 * 1000, // 1 hour
      hotCacheProtection: config?.hotCacheProtection ?? true,
    };

    // Default to LRU eviction strategy
    this.evictionStrategy = config?.evictionStrategy || new LRUEvictionStrategy();

    this.stats.maxSize = this.config.maxSize;

    // Auto cleanup expired entries every 5 minutes
    setInterval(() => this.cleanExpired(), 5 * 60 * 1000);
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
      findSegmentAtTime: this.findSegmentAtTime.bind(this),
      getSegmentsInRange: this.getSegmentsInTimeRange.bind(this),
      clearTimeMap: this.clearSegmentTimeMap.bind(this),
    };
  }

  // ============ Core Cache Operations ============

  /**
   * Store data in cache with TTL
   */
  set(key: string, data: CacheableData, ttl: number, isHot = false): void {
    const size = this.calculateSize(data);

    // Check if we need to evict (skip if hot cache item)
    if (!isHot) {
      while (this.currentSize + size > this.config.maxSize && this.cache.size > 0) {
        this.evict();
      }
    }

    // If item exists, remove old size
    const existing = this.cache.get(key);
    if (existing) {
      this.currentSize -= existing.size;
      this.removeFromAccessOrder(key);
    }

    // Create cache entry
    const entry: ICacheEntry<CacheableData> = {
      key,
      data,
      size,
      timestamp: Date.now(),
      ttl,
      accessCount: 0,
      lastAccessed: Date.now(),
    };

    // Add to cache
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

    this.cache.delete(key);
    this.hotCache.delete(key);
    this.currentSize -= entry.size;
    this.removeFromAccessOrder(key);
    this.updateStats();

    return true;
  }

  /**
   * Clear all cache
   */
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

  // ============ Seeder Fallback Endpoints ============

  /**
   * Get Seeder endpoint cho master playlist
   */
  getMasterPlaylistEndpoint(movieId: string): string {
    return this.seederEndpoints.masterPlaylist(movieId);
  }

  /**
   * Get Seeder endpoint cho variant playlist
   */
  getVariantPlaylistEndpoint(movieId: string, qualityId: string): string {
    return this.seederEndpoints.variantPlaylist(movieId, qualityId);
  }

  /**
   * Get Seeder endpoint cho init segment
   */
  getInitSegmentEndpoint(movieId: string, qualityId: string): string {
    return this.seederEndpoints.initSegment(movieId, qualityId);
  }

  /**
   * Get Seeder endpoint cho media segment
   */
  getMediaSegmentEndpoint(movieId: string, qualityId: string, segmentId: string): string {
    return this.seederEndpoints.mediaSegment(movieId, qualityId, segmentId);
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

  /**
   * Fetch và cache segment từ Seeder
   */
  async fetchAndCacheSegment(
    movieId: string,
    qualityId: string,
    segmentId: string
  ): Promise<ArrayBuffer> {
    // Check cache first
    const cached = this.getSegment(movieId, qualityId, segmentId);
    if (cached) {
      console.log(`[CacheManager] Cache hit: segment ${segmentId}`);
      return cached;
    }

    // Fetch from Seeder
    const endpoint = this.getMediaSegmentEndpoint(movieId, qualityId, segmentId);
    console.log(`[CacheManager] Fetching from Seeder: ${endpoint}`);
    
    const data = await this.fetchFromSeeder(endpoint);
    
    // Cache it
    this.setSegment(movieId, qualityId, segmentId, data);
    
    return data;
  }

  /**
   * Fetch và cache init segment từ Seeder
   */
  async fetchAndCacheInitSegment(movieId: string, qualityId: string): Promise<InitSegment> {
    // Check cache first
    const cached = this.getInitSegment(movieId, qualityId);
    if (cached) {
      console.log(`[CacheManager] Cache hit: init segment ${qualityId}`);
      return cached;
    }

    // Fetch from Seeder
    const endpoint = this.getInitSegmentEndpoint(movieId, qualityId);
    console.log(`[CacheManager] Fetching init from Seeder: ${endpoint}`);
    
    const data = await this.fetchFromSeeder(endpoint);
    
    const initSegment: InitSegment = {
      qualityId,
      data,
      url: endpoint,
    };
    
    // Cache it (HOT)
    this.setInitSegment(movieId, qualityId, initSegment);
    
    return initSegment;
  }

  // ============ LRU Eviction (skip hot cache) ============

  /**
   * Evict LRU item (skip hot cache items)
   */
  private evictLRU(): void {
    if (this.accessOrder.length === 0) return;

    // Find first non-hot cache item to evict
    for (let i = 0; i < this.accessOrder.length; i++) {
      const keyToEvict = this.accessOrder[i];
      
      if (!this.hotCache.has(keyToEvict)) {
        // Evict this item
        const entry = this.cache.get(keyToEvict);
        if (entry) {
          this.cache.delete(keyToEvict);
          this.currentSize -= entry.size;
          this.accessOrder.splice(i, 1);
          this.stats.evictions++;
          
          console.log(`[CacheManager] Evicted ${keyToEvict} (${this.formatSize(entry.size)})`);
        }
        return;
      }
    }

    console.warn('[CacheManager] All items are hot cache - cannot evict');
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
   * Get cache statistics
   */
  getStats(): CacheStats {
    return { ...this.stats };
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
      this.evictLRU();
    }
  }

  /**
   * Custom Seeder endpoints
   */
  setSeederEndpoints(endpoints: Partial<SeederEndpoints>): void {
    this.seederEndpoints = {
      ...this.seederEndpoints,
      ...endpoints,
    };
  }
}
