/**
 * Buffer Manager v2
 * Quản lý buffer playback với prefetch thông minh, sequential append và ABR support
 */

import type {
  SegmentMetadata,
  BufferStatus,
  Quality,
} from './types';
import { MseManager } from './MseManager';
import { ConfigManager } from './ConfigManager';
import { EventEmitter } from './interfaces/IEventEmitter';
import type { IBufferManager, IBufferMonitor, IBufferPrefetcher } from './interfaces/IBufferManager';

export interface BufferManagerEvents {
  bufferLow: (bufferAhead: number) => void;
  bufferCritical: (bufferAhead: number) => void;
  bufferHigh: (bufferAhead: number) => void;
  segmentNeeded: (segment: SegmentMetadata, critical: boolean) => void;
  segmentAppended: (segmentId: string) => void;
  bufferingStart: () => void;
  bufferingEnd: () => void;
  qualitySwitch: (fromQuality: string, toQuality: string) => void;
}

export interface SegmentAppendRequest {
  segment: SegmentMetadata;
  data: ArrayBuffer;
  priority: number; // Higher = more urgent
  forSeek?: boolean;
  timestamp: number; // For ordering
}

/**
 * Buffer Manager với tích hợp fetch logic và sequential append
 */
export class BufferManager extends EventEmitter<BufferManagerEvents> implements IBufferManager {
  private mseManager: MseManager;
  private configManager: ConfigManager;
  private videoElement: HTMLVideoElement;

  private currentQuality: Quality | null = null;
  private segments: SegmentMetadata[] = [];

  // Sequential append queue - CRITICAL: Đảm bảo không có gap trong timeline
  private appendQueue: SegmentAppendRequest[] = [];
  private isAppending = false;
  private appendedSegments = new Set<string>(); // Set of segmentKey: `${qualityId}:${segmentId}`
  private fetchingSegments = new Set<string>(); // Track segments currently being fetched
  private nextExpectedSegmentIndex: number = 0; // Index của segment tiếp theo cần append

  private isBuffering = false;
  private isSeeking = false;

  private monitorInterval: number | null = null;
  private lastCriticalFetchTime = 0; // Track last critical fetch to prevent spam (debounce)
  private isFetchingCritical = false; // Prevent concurrent critical fetches

  // Fetch callback - Injected from coordinator/integrated fetch client
  private fetchSegmentCallback: ((segment: SegmentMetadata, critical: boolean) => Promise<ArrayBuffer | null>) | null = null;

  constructor(
    videoElement: HTMLVideoElement,
    mseManager: MseManager,
    configManager: ConfigManager
  ) {
    super();
    this.videoElement = videoElement;
    this.mseManager = mseManager;
    this.configManager = configManager;

    this.setupVideoListeners();
  }

  /**
   * Inject fetch callback từ coordinator
   */
  setFetchCallback(callback: (segment: SegmentMetadata, critical: boolean) => Promise<ArrayBuffer | null>): void {
    this.fetchSegmentCallback = callback;
  }

  /**
   * Setup video element event listeners
   */
  private setupVideoListeners(): void {
    this.videoElement.addEventListener('seeking', () => {
      this.handleSeeking();
    });

    this.videoElement.addEventListener('seeked', () => {
      this.handleSeeked();
    });

    this.videoElement.addEventListener('waiting', () => {
      this.handleWaiting();
    });

    this.videoElement.addEventListener('playing', () => {
      this.handlePlaying();
    });
  }

  /**
   * Initialize buffer manager với quality và segments
   */
  async initialize(quality: Quality, segments: SegmentMetadata[]): Promise<void> {
    this.currentQuality = quality;
    this.segments = segments;
    this.appendedSegments.clear();
    this.appendQueue = [];
    this.nextExpectedSegmentIndex = 0; // Start from first segment

    // Start monitoring
    this.startMonitoring();

    // Initial prefetch to start buffering immediately
    this.prefetchCriticalSegments();

    console.log(`[BufferManager] Initialized with quality ${quality.id}, ${segments.length} segments`);
  }

  /**
   * Start buffer monitoring loop
   */
  startMonitoring(): void {
    if (this.monitorInterval) return;

    // Monitoring interval 1000ms
    this.monitorInterval = window.setInterval(() => {
      this.checkBufferHealth();

      // Cleanup every 10 seconds
      if (Date.now() % 10000 < 1000) {
        this.performPeriodicCleanup();
      }
    }, 1000);
  }

  /**
   * Stop buffer monitoring
   */
  stopMonitoring(): void {
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
      this.monitorInterval = null;
    }
  }

  /**
   * Periodic cleanup of old segment tracking
   */
  private performPeriodicCleanup(): void {
    const currentTime = this.videoElement.currentTime;
    const config = this.configManager.getConfig();
    this.cleanupOldAppendedSegments(currentTime, config);
  }

  /**
   * Kiểm tra buffer health và trigger prefetch
   */
  private checkBufferHealth(): void {
    if (!this.currentQuality) return;

    const status = this.getBufferStatus();
    const config = this.configManager.getConfig();

    // Kiểm tra xem đã đến cuối video chưa
    if (this.isNearEndOfStream()) {
      // Nếu đang buffering và gần cuối, kết thúc buffering
      if (this.isBuffering) {
        this.isBuffering = false;
        this.emit('bufferingEnd');
        console.log('[BufferManager] Buffering ended - reached end of stream');
      }
      return;
    }

    // CRITICAL: Buffer quá thấp → cần fetch ngay từ Seeder (HTTP)
    // Sử dụng 1/3 của bufferMinThreshold làm critical threshold
    const criticalThreshold = config.bufferMinThreshold / 3;

    if (status.bufferAhead < criticalThreshold) {
      this.emit('bufferCritical', status.bufferAhead);
      console.warn(`[BufferManager] CRITICAL buffer: ${status.bufferAhead.toFixed(2)}s`);
      this.prefetchCriticalSegments();
      return;
    }

    // LOW: Buffer thấp nhưng chưa critical
    if (status.bufferAhead < config.bufferMinThreshold) {
      this.emit('bufferLow', status.bufferAhead);
      this.prefetchSegments();
      return;
    }

    // NORMAL: Buffer đủ, tiếp tục prefetch theo window
    if (status.bufferAhead < config.bufferTargetDuration) {
      this.prefetchSegments();
    }
    // HIGH: Buffer đầy, không cần prefetch
    else if (status.bufferAhead > config.bufferMaxThreshold) {
      this.emit('bufferHigh', status.bufferAhead);
    }
  }

  /**
   * Prefetch segments CRITICAL - Force HTTP từ Seeder
   */
  private async prefetchCriticalSegments(): Promise<void> {
    if (!this.currentQuality || !this.fetchSegmentCallback) return;

    // Không fetch nếu gần cuối stream
    if (this.isNearEndOfStream()) {
      return;
    }

    // Debounce: Chỉ fetch critical mỗi 1 giây (giảm từ 2s để responsive hơn khi seek)
    const now = Date.now();
    if (now - this.lastCriticalFetchTime < 1000) {
      console.log('[BufferManager] Skipping critical fetch (debounce)');
      return;
    }

    // Prevent concurrent critical fetches
    if (this.isFetchingCritical) {
      console.log('[BufferManager] Critical fetch already in progress');
      return;
    }

    this.lastCriticalFetchTime = now;
    this.isFetchingCritical = true;

    const currentTime = this.videoElement.currentTime;
    const currentSegment = this.findSegmentAtTime(currentTime);

    if (!currentSegment) {
      console.log(`[BufferManager] No segment found at current time ${currentTime.toFixed(2)}s`);
      this.isFetchingCritical = false;
      return;
    }

    // Fetch ngay 3-5 segments tiếp theo với high priority (tăng từ 3 lên 5)
    const criticalCount = 5;
    const startIndex = this.segments.indexOf(currentSegment);

    console.log(`[BufferManager] Fetching ${criticalCount} CRITICAL segments from ${currentSegment.id} (index ${startIndex})`);

    const fetchPromises: Promise<void>[] = [];

    for (let i = 0; i < criticalCount && startIndex + i < this.segments.length; i++) {
      const segment = this.segments[startIndex + i];
      const segmentKey = this.getSegmentKey(segment);

      // Skip if already appended or currently being fetched
      if (this.appendedSegments.has(segmentKey)) continue;
      if (this.fetchingSegments.has(segmentKey)) {
        console.log(`[BufferManager] Segment ${segment.id} already being fetched, skipping duplicate request`);
        continue;
      }

      // Mark as fetching
      this.fetchingSegments.add(segmentKey);

      // For initial critical segments, skip P2P entirely and use HTTP directly
      // This avoids timeout issues when peers aren't ready yet
      console.log(`[BufferManager] Fetching CRITICAL segment ${segment.id} via HTTP (skipping P2P)`);
      this.emit('segmentNeeded', segment, true);

      // Add to parallel fetch promises
      fetchPromises.push(
        this.fetchSegmentCallback(segment, true)
          .then(data => {
            if (data) {
              this.queueSegmentForAppend(segment, data, 100, false); // Priority 100 = critical
            }
          })
          .catch(error => {
            console.error(`[BufferManager] Error fetching critical segment ${segment.id}:`, error);
          })
          .finally(() => {
            // Remove from fetching set when done
            this.fetchingSegments.delete(segmentKey);
          })
      );
    }

    // Wait for all critical fetches to complete (with Promise.allSettled to not fail if one fails)
    await Promise.allSettled(fetchPromises);
    this.isFetchingCritical = false;
  }

  /**
   * Prefetch segments theo prefetch_window
   */
  private async prefetchSegments(): Promise<void> {
    if (!this.currentQuality || !this.fetchSegmentCallback) return;

    const currentTime = this.videoElement.currentTime;
    const config = this.configManager.getConfig();

    // Cleanup appended segments outside prefetch window
    this.cleanupOldAppendedSegments(currentTime, config);

    // Calculate prefetch window
    const prefetchAheadTime = currentTime + config.prefetchWindowAhead;
    const prefetchBehindTime = Math.max(0, currentTime - config.prefetchWindowBehind);

    const startSeg = this.findSegmentAtTime(prefetchBehindTime);
    const endSeg = this.findSegmentAtTime(prefetchAheadTime);

    if (!startSeg || !endSeg) return;

    const startIndex = this.segments.indexOf(startSeg);
    const endIndex = this.segments.indexOf(endSeg);

    // Collect segments to fetch
    const segmentsToFetch: SegmentMetadata[] = [];

    for (let i = startIndex; i <= endIndex; i++) {
      const segment = this.segments[i];
      if (!segment) continue;

      const segmentKey = this.getSegmentKey(segment);
      // Skip if already appended or currently being fetched
      if (this.appendedSegments.has(segmentKey)) continue;
      if (this.fetchingSegments.has(segmentKey)) continue;

      segmentsToFetch.push(segment);
    }

    // Prioritize by distance to current time
    segmentsToFetch.sort((a, b) => {
      const distA = Math.abs(a.timestamp - currentTime);
      const distB = Math.abs(b.timestamp - currentTime);
      return distA - distB;
    });

    // Fetch với concurrency limit
    const maxConcurrent = config.maxConcurrentFetches;
    const promises: Promise<void>[] = [];

    for (let i = 0; i < Math.min(segmentsToFetch.length, maxConcurrent); i++) {
      const segment = segmentsToFetch[i];
      const segmentKey = this.getSegmentKey(segment);

      // Mark as fetching
      this.fetchingSegments.add(segmentKey);

      promises.push((async () => {
        try {
          this.emit('segmentNeeded', segment, false);
          const data = await this.fetchSegmentCallback!(segment, false);
          if (data) {
            const priority = 50 - Math.abs(segment.timestamp - currentTime); // Closer = higher priority
            this.queueSegmentForAppend(segment, data, priority, false);
          }
        } catch (error) {
          console.error(`[BufferManager] Error fetching segment ${segment.id}:`, error);
        } finally {
          this.fetchingSegments.delete(segmentKey);
        }
      })());
    }

    await Promise.allSettled(promises);
  }

  /**
   * Prefetch segments xung quanh vị trí seek
   */
  async prefetchSegmentsAroundSeek(seekTime: number): Promise<void> {
    if (!this.currentQuality || !this.fetchSegmentCallback) return;

    const config = this.configManager.getConfig();
    const seekSegment = this.findSegmentAtTime(seekTime);

    if (!seekSegment) {
      console.warn(`[BufferManager] No segment found at seek time ${seekTime}`);
      return;
    }

    const seekIndex = this.segments.indexOf(seekSegment);

    // Fetch window: 5 segments trước + 10 segments sau seek position
    const windowBefore = 5;
    const windowAfter = 10;

    const startIndex = Math.max(0, seekIndex - windowBefore);
    const endIndex = Math.min(this.segments.length - 1, seekIndex + windowAfter);

    const segmentsToFetch: Array<{ segment: SegmentMetadata; distance: number }> = [];

    for (let i = startIndex; i <= endIndex; i++) {
      const segment = this.segments[i];
      const segmentKey = this.getSegmentKey(segment);

      if (this.appendedSegments.has(segmentKey)) continue;

      const distance = Math.abs(i - seekIndex);
      segmentsToFetch.push({ segment, distance });
    }

    // Sort by distance - closest first
    segmentsToFetch.sort((a, b) => a.distance - b.distance);

    // Fetch in parallel (limited concurrency)
    const maxConcurrent = config.maxConcurrentFetches;

    for (let i = 0; i < segmentsToFetch.length; i += maxConcurrent) {
      const batch = segmentsToFetch.slice(i, i + maxConcurrent);

      await Promise.allSettled(
        batch.map(async ({ segment, distance }) => {
          this.emit('segmentNeeded', segment, distance === 0); // Segment đúng vị trí seek = critical
          const data = await this.fetchSegmentCallback!(segment, distance === 0);

          if (data) {
            // Priority cao nhất cho segment tại vị trí seek
            const priority = 100 - distance * 5;
            this.queueSegmentForAppend(segment, data, priority, true);
          }
        })
      );
    }

    console.log(`[BufferManager] Prefetched ${segmentsToFetch.length} segments around seek position`);
  }

  /**
   * Queue segment để append (sequential)
   */
  queueSegmentForAppend(
    segment: SegmentMetadata,
    data: ArrayBuffer,
    priority: number,
    forSeek: boolean
  ): void {
    const segmentKey = this.getSegmentKey(segment);

    // Check if already appended
    if (this.appendedSegments.has(segmentKey)) {
      console.log(`[BufferManager] Segment ${segmentKey} already appended, skipping`);
      return;
    }

    // Check if already in queue
    const existingIndex = this.appendQueue.findIndex(
      req => this.getSegmentKey(req.segment) === segmentKey
    );

    if (existingIndex !== -1) {
      // Update priority if higher
      if (this.appendQueue[existingIndex].priority < priority) {
        this.appendQueue[existingIndex].priority = priority;
        this.appendQueue[existingIndex].forSeek = forSeek;
      }
      return;
    }

    // Add to queue
    this.appendQueue.push({
      segment,
      data,
      priority,
      forSeek,
      timestamp: Date.now(),
    });

    // Sort by priority (higher first), then by timestamp
    this.appendQueue.sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      return a.timestamp - b.timestamp;
    });

    console.log(
      `[BufferManager] Queued segment ${segmentKey} with priority ${priority} (queue size: ${this.appendQueue.length})`
    );

    // Process queue
    this.processAppendQueue();
  }

  /**
   * Process append queue - SEQUENTIAL để tránh gap
   */
  private async processAppendQueue(): Promise<void> {
    if (this.isAppending) return; // Already processing
    if (this.appendQueue.length === 0) return;

    this.isAppending = true;

    while (this.appendQueue.length > 0) {
      // Lấy segment có priority cao nhất NHƯNG phải tuân thủ thứ tự sequential
      const request = this.findNextSequentialSegment();

      if (!request) {
        // Không có segment nào phù hợp với sequence → chờ fetch thêm
        const expectedSegment = this.segments[this.nextExpectedSegmentIndex];
        console.log(
          `[BufferManager] Waiting for segment ${expectedSegment?.id || this.nextExpectedSegmentIndex} to maintain sequence`
        );
        break;
      }

      const segmentKey = this.getSegmentKey(request.segment);

      try {
        // Append to MSE
        await this.mseManager.appendMediaSegment(request.data);

        this.appendedSegments.add(segmentKey);

        // Update next expected index
        const segmentIndex = this.segments.findIndex(s => s.id === request.segment.id);
        if (segmentIndex !== -1) {
          this.nextExpectedSegmentIndex = segmentIndex + 1;
        }

        this.emit('segmentAppended', request.segment.id);

        console.log(
          `[BufferManager] Appended segment ${segmentKey} sequentially (next expected index: ${this.nextExpectedSegmentIndex})`
        );
      } catch (error) {
        console.error(`[BufferManager] Failed to append segment ${segmentKey}:`, error);
      }

      // Remove from queue
      const index = this.appendQueue.indexOf(request);
      if (index !== -1) {
        this.appendQueue.splice(index, 1);
      }

      // Small delay to avoid overwhelming MSE
      await new Promise(resolve => setTimeout(resolve, 10));
    }

    this.isAppending = false;
  }

  /**
   * Tìm segment tiếp theo phù hợp với sequential order
   */
  private findNextSequentialSegment(): SegmentAppendRequest | null {
    // Nếu đang seek, cho phép append segment bất kỳ (reset sequence)
    if (this.isSeeking && this.appendQueue.length > 0) {
      const seekRequest = this.appendQueue.find(req => req.forSeek);
      if (seekRequest) {
        const segmentIndex = this.segments.findIndex(s => s.id === seekRequest.segment.id);
        if (segmentIndex !== -1) {
          this.nextExpectedSegmentIndex = segmentIndex;
        }
        return seekRequest;
      }
    }

    // Tìm segment có index = nextExpectedSegmentIndex
    const expectedSegment = this.segments[this.nextExpectedSegmentIndex];
    if (expectedSegment) {
      const exactMatch = this.appendQueue.find(
        req => req.segment.id === expectedSegment.id
      );
      if (exactMatch) return exactMatch;
    }

    // Chỉ reset sequence nếu buffer hoàn toàn rỗng VÀ chưa có segment nào được append
    const status = this.getBufferStatus();
    if (status.buffered.length === 0 && this.appendedSegments.size === 0) {
      // Lần đầu tiên - tìm segment có index nhỏ nhất trong queue (thường là seg_0000)
      const sortedByIndex = [...this.appendQueue].sort((a, b) => {
        const indexA = this.segments.findIndex(s => s.id === a.segment.id);
        const indexB = this.segments.findIndex(s => s.id === b.segment.id);
        return indexA - indexB;
      });

      const firstSegment = sortedByIndex[0];
      if (firstSegment) {
        const segmentIndex = this.segments.findIndex(s => s.id === firstSegment.segment.id);
        if (segmentIndex !== -1) {
          this.nextExpectedSegmentIndex = segmentIndex;
          console.log(`[BufferManager] Initializing sequence from index ${segmentIndex} (${firstSegment.segment.id})`);
        }
        return firstSegment;
      }
    }

    return null; // Phải chờ đúng segment trong sequence
  }

  /**
   * Handle seeking event
   */
  private async handleSeeking(): Promise<void> {
    console.log('[BufferManager] Seeking to', this.videoElement.currentTime);
    this.isSeeking = true;

    // Clear append queue (các segment cũ không còn cần thiết)
    const queueSize = this.appendQueue.length;
    this.appendQueue = [];
    if (queueSize > 0) {
      console.log(`[BufferManager] Cleared ${queueSize} segments from append queue due to seek`);
    }

    // Notify MSE về seek
    await this.mseManager.handleSeek(this.videoElement.currentTime);
  }

  /**
   * Handle seeked event
   */
  private async handleSeeked(): Promise<void> {
    const seekTime = this.videoElement.currentTime;
    console.log('[BufferManager] Seeked to', seekTime);

    // Reset sequence từ vị trí seek
    const seekSegment = this.findSegmentAtTime(seekTime);
    if (seekSegment) {
      const segmentIndex = this.segments.findIndex(s => s.id === seekSegment.id);
      if (segmentIndex !== -1) {
        this.nextExpectedSegmentIndex = segmentIndex;
        console.log(`[BufferManager] Reset sequence to index ${segmentIndex} (${seekSegment.id})`);
      }
    }

    this.isSeeking = false;

    // Prefetch segments xung quanh vị trí seek
    await this.prefetchSegmentsAroundSeek(seekTime);

    // Trigger immediate buffer check sau seek để đảm bảo fetch tiếp tục
    this.checkBufferHealth();
  }

  /**
   * Handle waiting event (buffering)
   */
  private handleWaiting(): void {
    // Không buffering nếu video đã kết thúc
    if (this.videoElement.ended) {
      console.log('[BufferManager] Ignoring waiting event - video has ended');
      return;
    }

    // Không buffering nếu gần cuối stream và không còn gì để fetch
    if (this.isNearEndOfStream()) {
      console.log('[BufferManager] Ignoring waiting event - near end of stream');
      return;
    }

    if (!this.isBuffering) {
      this.isBuffering = true;
      this.emit('bufferingStart');

      const status = this.getBufferStatus();
      console.log(`[BufferManager] Buffering started - buffer ahead: ${status.bufferAhead.toFixed(2)}s`);

      // Trigger critical fetch để load segments cần thiết ngay lập tức
      this.prefetchCriticalSegments();
    }
  }

  /**
   * Handle playing event
   */
  private handlePlaying(): void {
    if (this.isBuffering) {
      this.isBuffering = false;
      this.emit('bufferingEnd');
      console.log('[BufferManager] Buffering ended');
    }
  }

  /**
   * Map time → segmentId
   */
  mapTimeToSegmentId(time: number): string | null {
    const segment = this.findSegmentAtTime(time);
    return segment ? segment.id : null;
  }

  /**
   * Tìm segment tại thời điểm cụ thể
   */
  private findSegmentAtTime(time: number): SegmentMetadata | null {
    if (this.segments.length === 0) return null;

    for (let i = 0; i < this.segments.length; i++) {
      const segment = this.segments[i];
      const nextSegment = this.segments[i + 1];

      const segmentStart = segment.timestamp;
      const segmentEnd = nextSegment ? nextSegment.timestamp : Infinity;

      if (time >= segmentStart && time < segmentEnd) {
        return segment;
      }
    }

    // Nếu không tìm thấy (có thể time vượt quá segment cuối do rounding),
    // trả về segment cuối cùng nếu time gần với nó
    const lastSegment = this.segments[this.segments.length - 1];
    if (time >= lastSegment.timestamp) {
      return lastSegment;
    }

    return null;
  }

  /**
   * Tìm segment tiếp theo sau thời điểm cụ thể
   * Dùng cho quality switch để tìm segment tiếp theo cần fetch
   */
  private findNextSegmentAfterTime(time: number): SegmentMetadata | null {
    if (this.segments.length === 0) return null;

    for (let i = 0; i < this.segments.length; i++) {
      const segment = this.segments[i];
      // Tìm segment đầu tiên có timestamp > currentTime
      if (segment.timestamp > time) {
        return segment;
      }
    }

    // Nếu không tìm thấy, trả về segment cuối (EOF)
    return this.segments[this.segments.length - 1] || null;
  }

  /**
   * Kiểm tra xem đã gần đến cuối stream chưa
   * Trả về true nếu tất cả segments đã được append hoặc không còn segment nào để fetch
   */
  private isNearEndOfStream(): boolean {
    if (this.segments.length === 0) return false;

    const currentTime = this.videoElement.currentTime;
    const currentSegment = this.findSegmentAtTime(currentTime);
    if (!currentSegment) return false;

    const currentIndex = this.segments.indexOf(currentSegment);
    if (currentIndex === -1) return false;

    // Đếm số segments còn lại chưa append (bao gồm cả segment hiện tại)
    let remainingSegments = 0;
    for (let i = currentIndex; i < this.segments.length; i++) {
      const segment = this.segments[i];
      const segmentKey = this.getSegmentKey(segment);
      if (!this.appendedSegments.has(segmentKey)) {
        remainingSegments++;
      }
    }

    // CHỈ trả về true nếu KHÔNG còn segment nào chưa append
    // Loại bỏ check duration vì có thể không chính xác
    const noRemainingSegments = remainingSegments === 0;

    if (noRemainingSegments) {
      return true;
    }

    return false;
  }

  /**
   * Get buffer status
   */
  getBufferStatus(): BufferStatus {
    const currentTime = this.videoElement.currentTime;
    const duration = this.videoElement.duration || 0;
    const bufferedRanges = this.mseManager.getBufferedRanges();
    const bufferAhead = this.mseManager.getBufferedAhead(currentTime);

    // Calculate buffer behind
    let bufferBehind = 0;
    for (const range of bufferedRanges) {
      if (currentTime >= range.start && currentTime <= range.end) {
        bufferBehind = currentTime - range.start;
        break;
      }
    }

    return {
      buffered: bufferedRanges,
      currentTime,
      duration,
      bufferAhead,
      bufferBehind,
    };
  }

  /**
   * Switch quality (ABR) - Fetch init segment + segments mới
   * Giữ nguyên timeline, chỉ xóa prefetch segments và fetch segment tiếp theo ở quality mới
   */
  async switchQuality(
    newQuality: Quality,
    newSegments: SegmentMetadata[],
    initSegment: { data: ArrayBuffer; url: string },
    skipInitAppend = false
  ): Promise<void> {
    if (!this.currentQuality) return;

    const oldQualityId = this.currentQuality.id;
    console.log(`[BufferManager] Switching quality from ${oldQualityId} to ${newQuality.id}`);

    this.emit('qualitySwitch', oldQualityId, newQuality.id);

    // Clear append queue - xóa các segment đang chờ append
    this.appendQueue = [];

    // Update quality và segments
    this.currentQuality = newQuality;
    this.segments = newSegments;

    // Append init segment của quality mới (bỏ qua nếu đã append bởi MSE manager)
    if (skipInitAppend) {
      console.log('[BufferManager] Skipping init append because MSE already appended it');
    } else {
      try {
        const initSegmentObj = {
          qualityId: newQuality.id,
          data: initSegment.data,
          url: initSegment.url,
        };

        await this.mseManager.appendInitSegment(initSegmentObj);
        console.log(`[BufferManager] Appended init segment for quality ${newQuality.id}`);
      } catch (error) {
        console.error('[BufferManager] Failed to append init segment:', error);
        return;
      }
    }

    // Cập nhật appendedSegments: xóa các segment của quality cũ sau currentTime
    // Giữ lại các segment đã append trước currentTime để tránh gap
    const currentTime = this.videoElement.currentTime;
    const segmentsToRemove: string[] = [];

    for (const segmentKey of this.appendedSegments) {
      const [qualityId] = segmentKey.split(':');
      if (qualityId === oldQualityId) {
        // Tìm segment trong old quality segments để check time
        const segment = this.segments.find(s => this.getSegmentKey(s) === segmentKey);
        // Xóa nếu segment sau currentTime (đã bị remove khỏi buffer)
        if (!segment || (segment.startTime && segment.startTime >= currentTime)) {
          segmentsToRemove.push(segmentKey);
        }
      }
    }

    for (const key of segmentsToRemove) {
      this.appendedSegments.delete(key);
    }
    console.log(`[BufferManager] Removed ${segmentsToRemove.length} old quality segments from tracking`);

    // Tìm segment tiếp theo tại vị trí currentTime trong quality mới
    const nextSegment = this.findNextSegmentAfterTime(currentTime);

    if (nextSegment) {
      const nextIndex = this.segments.indexOf(nextSegment);
      if (nextIndex !== -1) {
        this.nextExpectedSegmentIndex = nextIndex;
        console.log(`[BufferManager] Next segment after quality switch: #${nextIndex} (${nextSegment.id})`);
        await this.prefetchSegmentsForQualitySwitch(nextIndex);
      }
    } else {
      console.warn('[BufferManager] No next segment found after quality switch');
    }
  }

  /**
   * Prefetch segments immediately after a quality switch.
   * Fetches the next segment at the new quality to continue playback seamlessly.
   */
  private async prefetchSegmentsForQualitySwitch(nextIndex: number): Promise<void> {
    if (!this.fetchSegmentCallback) return;

    const maxAhead = 3; // next segment + 2 more to rebuild buffer quickly

    for (let offset = 0; offset < maxAhead; offset++) {
      const segment = this.segments[nextIndex + offset];
      if (!segment) break;

      const segmentKey = this.getSegmentKey(segment);
      if (this.appendedSegments.has(segmentKey)) continue;

      const isCritical = offset === 0; // First segment is critical
      const priority = isCritical ? 120 : 90 - offset * 10;

      this.emit('segmentNeeded', segment, isCritical);

      try {
        const data = await this.fetchSegmentCallback(segment, isCritical);
        if (data) {
          this.queueSegmentForAppend(segment, data, priority, isCritical);
        }
      } catch (error) {
        console.warn(
          `[BufferManager] Failed to prefetch segment ${segment.id} during quality switch:`,
          error
        );
      }
    }
  }

  /**
   * Get segment key
   */
  private getSegmentKey(segment: SegmentMetadata): string {
    return `${segment.qualityId}:${segment.id}`;
  }

  /**
   * Cleanup old appended segments outside the prefetch window
   * This prevents memory buildup and allows re-fetching when seeking back
   */
  private cleanupOldAppendedSegments(currentTime: number, config: any): void {
    // Expanded cleanup window to match larger prefetch window
    // Keep extra 120s buffer (2 minutes) for better cache utilization
    const cleanupBehindTime = currentTime - (config.prefetchWindowBehind + 120);
    const cleanupAheadTime = currentTime + (config.prefetchWindowAhead + 120);

    const segmentsToRemove: string[] = [];

    // Check all appended segments
    for (const segmentKey of this.appendedSegments) {
      // Find the segment metadata
      const segment = this.segments.find(s => this.getSegmentKey(s) === segmentKey);
      if (!segment) {
        // Segment not found in current list, remove from tracking
        segmentsToRemove.push(segmentKey);
        continue;
      }

      // Remove if outside cleanup window
      if (segment.timestamp < cleanupBehindTime || segment.timestamp > cleanupAheadTime) {
        segmentsToRemove.push(segmentKey);
      }
    }

    // Remove tracked segments
    if (segmentsToRemove.length > 0) {
      for (const key of segmentsToRemove) {
        this.appendedSegments.delete(key);
      }
      console.log(`[BufferManager] Cleaned up ${segmentsToRemove.length} old segment references (current: ${this.appendedSegments.size})`);
    }
  }

  /**
   * Get appended segments
   */
  getAppendedSegments(): string[] {
    return Array.from(this.appendedSegments);
  }

  /**
   * Get pending segments count
   */
  getPendingSegmentsCount(): number {
    return this.appendQueue.length;
  }

  /**
   * Prefetch segments (IBufferPrefetcher interface)
   */
  prefetch(count: number): void {
    this.prefetchSegments(count);
  }

  /**
   * Cleanup
   */
  destroy(): void {
    this.stopMonitoring();
    this.appendQueue = [];
    this.appendedSegments.clear();
    this.segments = [];
    this.fetchSegmentCallback = null;
    console.log('[BufferManager] Disposed');
  }
}
