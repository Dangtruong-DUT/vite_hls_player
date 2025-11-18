/**
 * Buffer Management Interfaces
 * Applies Strategy Pattern and Interface Segregation Principle
 */

import type { SegmentMetadata, BufferStatus, Quality } from '../types';

/**
 * Buffer Prefetch Strategy Interface (Strategy Pattern)
 */
export interface IBufferPrefetchStrategy {
  /**
   * Strategy name
   */
  readonly name: string;

  /**
   * Determine which segments to prefetch
   */
  selectSegmentsToPrefetch(
    currentTime: number,
    bufferStatus: BufferStatus,
    allSegments: SegmentMetadata[],
    appendedSegments: Set<string>
  ): SegmentMetadata[];

  /**
   * Get prefetch priority for a segment
   */
  getPriority(segment: SegmentMetadata, currentTime: number): number;
}

/**
 * Buffer Health Monitor Interface (SRP - Health monitoring)
 */
export interface IBufferHealthMonitor {
  /**
   * Check buffer health and return status
   */
  checkHealth(bufferStatus: BufferStatus): {
    level: 'critical' | 'low' | 'normal' | 'high';
    shouldPrefetch: boolean;
    shouldBuffer: boolean;
  };

  /**
   * Check if near end of stream
   */
  isNearEndOfStream(currentTime: number, duration: number, threshold?: number): boolean;

  /**
   * Get buffer status
   */
  getBufferStatus(): BufferStatus;
}

/**
 * Segment Append Queue Interface (SRP - Queue management)
 */
export interface ISegmentAppendQueue {
  /**
   * Add segment to queue
   */
  enqueue(segment: SegmentMetadata, data: ArrayBuffer, priority: number, forSeek?: boolean): void;

  /**
   * Process next segment in queue
   */
  processNext(): Promise<void>;

  /**
   * Check if segment is in queue
   */
  hasSegment(segmentKey: string): boolean;

  /**
   * Clear queue
   */
  clear(): void;

  /**
   * Get queue size
   */
  size(): number;

  /**
   * Check if queue is processing
   */
  isProcessing(): boolean;
}

/**
 * Buffer Manager Interface
 */
export interface IBufferManager {
  /**
   * Initialize buffer manager
   */
  initialize(quality: Quality, segments: SegmentMetadata[]): Promise<void>;

  /**
   * Update quality and segments
   */
  updateQuality(quality: Quality, segments: SegmentMetadata[]): Promise<void>;

  /**
   * Start buffer monitoring
   */
  startMonitoring(): void;

  /**
   * Stop buffer monitoring
   */
  stopMonitoring(): void;

  /**
   * Get buffer status
   */
  getBufferStatus(): BufferStatus;

  /**
   * Handle seek operation
   */
  handleSeek(targetTime: number): Promise<void>;

  /**
   * Set fetch callback
   */
  setFetchCallback(
    callback: (segment: SegmentMetadata, critical: boolean) => Promise<ArrayBuffer | null>
  ): void;

  /**
   * Set prefetch strategy
   */
  setPrefetchStrategy(strategy: IBufferPrefetchStrategy): void;

  /**
   * Clean up resources
   */
  destroy(): void;
}

/**
 * Segment Fetch Callback Interface
 */
export interface ISegmentFetchCallback {
  (segment: SegmentMetadata, critical: boolean): Promise<ArrayBuffer | null>;
}
