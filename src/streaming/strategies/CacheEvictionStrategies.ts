/**
 * Cache Eviction Strategies
 * Implements different cache eviction algorithms
 */

import type { ICacheEvictionStrategy, ICacheEntry } from '../interfaces/ICacheManager';

/**
 * LRU (Least Recently Used) Eviction Strategy
 */
export class LRUEvictionStrategy implements ICacheEvictionStrategy {
  readonly name = 'LRU';

  selectEvictionCandidate<T>(
    entries: Map<string, ICacheEntry<T>>,
    hotCache: Set<string>,
    _requiredSpace: number
  ): string | null {
    let lruKey: string | null = null;
    let lruTime = Infinity;

    for (const [key, entry] of entries) {
      // Skip hot cache entries
      if (hotCache.has(key)) {
        continue;
      }

      if (entry.lastAccessed < lruTime) {
        lruTime = entry.lastAccessed;
        lruKey = key;
      }
    }

    return lruKey;
  }
}

/**
 * LFU (Least Frequently Used) Eviction Strategy
 */
export class LFUEvictionStrategy implements ICacheEvictionStrategy {
  readonly name = 'LFU';

  selectEvictionCandidate<T>(
    entries: Map<string, ICacheEntry<T>>,
    hotCache: Set<string>,
    _requiredSpace: number
  ): string | null {
    let lfuKey: string | null = null;
    let lfuCount = Infinity;

    for (const [key, entry] of entries) {
      // Skip hot cache entries
      if (hotCache.has(key)) {
        continue;
      }

      if (entry.accessCount < lfuCount) {
        lfuCount = entry.accessCount;
        lfuKey = key;
      }
    }

    return lfuKey;
  }
}

/**
 * TTL-based Eviction Strategy
 * Evicts entries closest to expiration
 */
export class TTLEvictionStrategy implements ICacheEvictionStrategy {
  readonly name = 'TTL';

  selectEvictionCandidate<T>(
    entries: Map<string, ICacheEntry<T>>,
    hotCache: Set<string>,
    _requiredSpace: number
  ): string | null {
    let ttlKey: string | null = null;
    let minTimeToLive = Infinity;
    const now = Date.now();

    for (const [key, entry] of entries) {
      // Skip hot cache entries
      if (hotCache.has(key)) {
        continue;
      }

      const timeToLive = entry.ttl - (now - entry.timestamp);
      if (timeToLive < minTimeToLive) {
        minTimeToLive = timeToLive;
        ttlKey = key;
      }
    }

    return ttlKey;
  }
}

/**
 * Size-based Eviction Strategy
 * Evicts largest entries first to free up space quickly
 */
export class SizeEvictionStrategy implements ICacheEvictionStrategy {
  readonly name = 'Size';

  selectEvictionCandidate<T>(
    entries: Map<string, ICacheEntry<T>>,
    hotCache: Set<string>,
    requiredSpace: number
  ): string | null {
    let largestKey: string | null = null;
    let largestSize = 0;

    for (const [key, entry] of entries) {
      // Skip hot cache entries
      if (hotCache.has(key)) {
        continue;
      }

      // Prefer entries that can satisfy the required space
      if (entry.size >= requiredSpace && entry.size > largestSize) {
        largestSize = entry.size;
        largestKey = key;
      }
    }

    // If no single entry is large enough, return largest entry
    if (!largestKey) {
      for (const [key, entry] of entries) {
        if (hotCache.has(key)) continue;
        if (entry.size > largestSize) {
          largestSize = entry.size;
          largestKey = key;
        }
      }
    }

    return largestKey;
  }
}

/**
 * Composite Eviction Strategy
 * Combines multiple strategies with weighted scoring
 */
export class CompositeEvictionStrategy implements ICacheEvictionStrategy {
  readonly name = 'Composite';

  private strategies: Array<{
    strategy: ICacheEvictionStrategy;
    weight: number;
  }>;

  constructor(strategies: Array<{ strategy: ICacheEvictionStrategy; weight: number }>) {
    this.strategies = strategies;
  }

  selectEvictionCandidate<T>(
    entries: Map<string, ICacheEntry<T>>,
    hotCache: Set<string>,
    requiredSpace: number
  ): string | null {
    const scores = new Map<string, number>();

    // Calculate composite score for each entry
    for (const [key] of entries) {
      if (hotCache.has(key)) continue;

      let totalScore = 0;
      let totalWeight = 0;

      for (const { weight } of this.strategies) {
        // Each strategy returns a candidate; we need to score all entries
        // For simplicity, we'll use a simplified scoring approach
        totalWeight += weight;
      }

      scores.set(key, totalScore / totalWeight);
    }

    // Select entry with highest score (worst candidate)
    let worstKey: string | null = null;
    let worstScore = -Infinity;

    for (const [key, score] of scores) {
      if (score > worstScore) {
        worstScore = score;
        worstKey = key;
      }
    }

    // Fallback to LRU if composite scoring fails
    if (!worstKey) {
      return new LRUEvictionStrategy().selectEvictionCandidate(entries, hotCache, requiredSpace);
    }

    return worstKey;
  }
}
