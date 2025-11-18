/**
 * Fetch Strategy Interfaces
 * Applies Strategy Pattern and Chain of Responsibility Pattern
 */

import type {
  SegmentMetadata,
  FetchResult,
  FetchSource,
  InitSegment,
  MasterPlaylist,
  VariantPlaylist,
} from '../types';

/**
 * Fetch Strategy Interface (Strategy Pattern)
 * Each strategy implements a different way to fetch segments
 */
export interface IFetchStrategy {
  /**
   * Strategy name for identification
   */
  readonly name: FetchSource;

  /**
   * Priority of this strategy (higher = try first)
   */
  readonly priority: number;

  /**
   * Check if this strategy can handle the request
   */
  canHandle(segment: SegmentMetadata, critical?: boolean): Promise<boolean>;

  /**
   * Fetch segment using this strategy
   */
  fetch(segment: SegmentMetadata, timeout: number): Promise<FetchResult>;

  /**
   * Cancel ongoing fetch if supported
   */
  cancel?(segment: SegmentMetadata): void;
}

/**
 * Fetch Handler Interface (Chain of Responsibility Pattern)
 */
export interface IFetchHandler {
  /**
   * Set next handler in chain
   */
  setNext(handler: IFetchHandler): IFetchHandler;

  /**
   * Handle fetch request, passing to next if cannot handle
   */
  handle(segment: SegmentMetadata, critical?: boolean): Promise<FetchResult>;
}

/**
 * Segment Fetcher Interface (Main fetch coordinator)
 */
export interface ISegmentFetcher {
  /**
   * Fetch media segment
   */
  fetchMediaSegment(segment: SegmentMetadata, options?: {
    timeout?: number;
    retries?: number;
    priority?: number;
    preferPeer?: boolean;
  }): Promise<FetchResult>;

  /**
   * Fetch init segment
   */
  fetchInitSegment(qualityId: string): Promise<InitSegment>;

  /**
   * Fetch master playlist
   */
  fetchMasterPlaylist(): Promise<MasterPlaylist>;

  /**
   * Fetch variant playlist
   */
  fetchVariantPlaylist(qualityId: string): Promise<VariantPlaylist>;

  /**
   * Batch fetch multiple segments
   */
  fetchSegments(
    segments: SegmentMetadata[],
    options?: {
      timeout?: number;
      retries?: number;
      priority?: number;
    }
  ): Promise<Map<string, FetchResult>>;

  /**
   * Cancel specific fetch
   */
  cancelFetch(qualityId: string, segmentId: string): void;

  /**
   * Cancel all ongoing fetches
   */
  cancelAllFetches(): void;
}

/**
 * Playlist Parser Interface (SRP - Parsing logic)
 */
export interface IPlaylistParser {
  /**
   * Parse master playlist
   */
  parseMasterPlaylist(content: string, baseUrl: string): MasterPlaylist;

  /**
   * Parse variant playlist
   */
  parseVariantPlaylist(content: string, qualityId: string, movieId: string): VariantPlaylist;
}

/**
 * HTTP Fetcher Interface (SRP - HTTP operations)
 */
export interface IHttpFetcher {
  /**
   * Fetch with timeout
   */
  fetchWithTimeout(url: string, timeout: number, signal?: AbortSignal): Promise<Response>;

  /**
   * Fetch with retries
   */
  fetchWithRetries(
    url: string,
    maxRetries: number,
    retryDelay: number,
    timeout: number
  ): Promise<Response>;
}

/**
 * Fetch Statistics Tracker Interface (SRP - Statistics)
 */
export interface IFetchStatistics {
  /**
   * Record successful fetch
   */
  recordSuccess(source: FetchSource, latency: number, size: number): void;

  /**
   * Record failed fetch
   */
  recordFailure(source: FetchSource, error: Error): void;

  /**
   * Get statistics
   */
  getStats(): {
    totalFetches: number;
    p2pFetches: number;
    httpFetches: number;
    cacheFetches: number;
    failedFetches: number;
    avgP2pLatency: number;
    avgHttpLatency: number;
    p2pSuccessRate: number;
    httpSuccessRate: number;
  };

  /**
   * Reset statistics
   */
  resetStats(): void;
}
