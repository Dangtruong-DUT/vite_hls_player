import type { CacheableData } from '../CacheManager';

export interface ICacheEntry<T = CacheableData> {
  key: string;
  data: T;
  size: number;
  timestamp: number;
  ttl: number;
  accessCount: number;
  lastAccessed: number;
}

export interface ICacheEvictionStrategy {
  selectEvictionCandidate<T>(
    entries: Map<string, ICacheEntry<T>>,
    hotCache: Set<string>,
    requiredSpace: number
  ): string | null;
  readonly name: string;
}

export interface ICacheManager {
  set(key: string, data: CacheableData, ttl: number, isHot?: boolean): void;
  get<T extends CacheableData = CacheableData>(key: string): T | null;
  has(key: string): boolean;
  delete(key: string): boolean;
  clear(): void;
  getCurrentSize(): number;
  getItemCount(): number;
  getStats(): {
    hits: number;
    misses: number;
    evictions: number;
    currentSize: number;
    maxSize: number;
    itemCount: number;
    hitRate: number;
  };
  setEvictionStrategy(strategy: ICacheEvictionStrategy): void;
  getTimeMapper(): {
    buildTimeMap(movieId: string, qualityId: string, segments: Array<{
      id: string;
      timestamp: number;
      duration: number;
    }>): void;
    findSegmentAtTime(movieId: string, qualityId: string, time: number): string | null;
    getSegmentsInRange(
      movieId: string,
      qualityId: string,
      startTime: number,
      endTime: number
    ): string[];
    clearTimeMap(movieId: string, qualityId?: string): void;
  };
}
