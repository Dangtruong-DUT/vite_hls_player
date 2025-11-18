/**
 * Cache Strategy Interfaces
 * Applies Strategy Pattern and Interface Segregation Principle
 */

import type { CacheableData } from '../CacheManager';

/**
 * Cache Entry Interface
 */
export interface ICacheEntry<T = CacheableData> {
  key: string;
  data: T;
  size: number;
  timestamp: number;
  ttl: number;
  accessCount: number;
  lastAccessed: number;
}

/**
 * Cache Eviction Strategy Interface (Strategy Pattern)
 */
export interface ICacheEvictionStrategy {
  /**
   * Select which cache entry to evict
   * @param entries - Array of cache entries
   * @param requiredSpace - Amount of space needed
   * @returns Key of entry to evict, or null if no entry should be evicted
   */
  selectEvictionCandidate<T>(
    entries: Map<string, ICacheEntry<T>>,
    hotCache: Set<string>,
    requiredSpace: number
  ): string | null;

  /**
   * Strategy name for debugging/logging
   */
  readonly name: string;
}

/**
 * Cache Storage Interface (SRP - Storage operations)
 */
export interface ICacheStorage {
  /**
   * Store data in cache
   */
  set(key: string, data: CacheableData, ttl: number, isHot?: boolean): void;

  /**
   * Get data from cache
   */
  get<T extends CacheableData = CacheableData>(key: string): T | null;

  /**
   * Check if key exists and is valid
   */
  has(key: string): boolean;

  /**
   * Delete specific key
   */
  delete(key: string): boolean;

  /**
   * Clear all cache
   */
  clear(): void;

  /**
   * Get current cache size in bytes
   */
  getCurrentSize(): number;

  /**
   * Get number of cached items
   */
  getItemCount(): number;
}

/**
 * Cache Statistics Interface (SRP - Statistics tracking)
 */
export interface ICacheStatistics {
  /**
   * Get cache statistics
   */
  getStats(): {
    hits: number;
    misses: number;
    evictions: number;
    currentSize: number;
    maxSize: number;
    itemCount: number;
    hitRate: number;
  };

  /**
   * Record cache hit
   */
  recordHit(): void;

  /**
   * Record cache miss
   */
  recordMiss(): void;

  /**
   * Record eviction
   */
  recordEviction(): void;

  /**
   * Reset statistics
   */
  resetStats(): void;
}

/**
 * Segment Time Mapper Interface (SRP - Time-based lookup)
 */
export interface ISegmentTimeMapper {
  /**
   * Build time mapping for a quality variant
   */
  buildTimeMap(movieId: string, qualityId: string, segments: Array<{
    id: string;
    timestamp: number;
    duration: number;
  }>): void;

  /**
   * Find segment ID at specific time
   */
  findSegmentAtTime(movieId: string, qualityId: string, time: number): string | null;

  /**
   * Get segments in time range
   */
  getSegmentsInRange(
    movieId: string,
    qualityId: string,
    startTime: number,
    endTime: number
  ): string[];

  /**
   * Clear time map for specific quality or all
   */
  clearTimeMap(movieId: string, qualityId?: string): void;
}

/**
 * Complete Cache Manager Interface
 */
export interface ICacheManager extends ICacheStorage, ICacheStatistics {
  /**
   * Set eviction strategy
   */
  setEvictionStrategy(strategy: ICacheEvictionStrategy): void;

  /**
   * Get segment time mapper
   */
  getTimeMapper(): ISegmentTimeMapper;
}
