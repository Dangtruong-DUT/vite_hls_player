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

export interface BufferManagerEvents {
  bufferLow: (bufferAhead: number) => void;
  bufferCritical: (bufferAhead: number) => void;
  bufferHigh: (bufferAhead: number) => void;
  segmentNeeded: (segment: SegmentMetadata, critical: boolean) => void;
  segmentAppended: (segmentId: number) => void;
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
export class BufferManager {
  private mseManager: MseManager;
  private configManager: ConfigManager;
  private videoElement: HTMLVideoElement;

  private currentQuality: Quality | null = null;
  private segments: SegmentMetadata[] = [];
  
  // Sequential append queue - CRITICAL: Đảm bảo không có gap trong timeline
  private appendQueue: SegmentAppendRequest[] = [];
  private isAppending = false;
  private appendedSegments = new Set<string>(); // Set of segmentKey: `${qualityId}:${segmentId}`
  private nextExpectedSegmentId = 0; // Segment ID tiếp theo cần append
  
  private isBuffering = false;
  private isSeeking = false;
  
  private monitorInterval: number | null = null;
  private eventListeners: Partial<BufferManagerEvents> = {};

  // Fetch callback - Injected from coordinator/integrated fetch client
  private fetchSegmentCallback: ((segment: SegmentMetadata, critical: boolean) => Promise<ArrayBuffer | null>) | null = null;

  constructor(
    videoElement: HTMLVideoElement,
    mseManager: MseManager,
    configManager: ConfigManager
  ) {
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
    this.nextExpectedSegmentId = 0;

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
    
    this.monitorInterval = window.setInterval(() => {
      this.checkBufferHealth();
    }, 500); // Check mỗi 500ms để responsive hơn
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
   * Kiểm tra buffer health và trigger prefetch
   */
  private checkBufferHealth(): void {
    if (this.isSeeking || !this.currentQuality) return;

    const status = this.getBufferStatus();
    const config = this.configManager.getConfig();

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

    const currentTime = this.videoElement.currentTime;
    const currentSegment = this.findSegmentAtTime(currentTime);
    
    if (!currentSegment) return;

    // Fetch ngay 2-3 segments tiếp theo với high priority
    const criticalCount = 3;
    const startIndex = this.segments.indexOf(currentSegment);
    
    for (let i = 0; i < criticalCount && startIndex + i < this.segments.length; i++) {
      const segment = this.segments[startIndex + i];
      const segmentKey = this.getSegmentKey(segment);
      
      if (this.appendedSegments.has(segmentKey)) continue;

      // Fetch với critical flag = true → IntegratedFetchClient sẽ fallback HTTP ngay
      console.log(`[BufferManager] Fetching CRITICAL segment ${segment.id}`);
      this.emit('segmentNeeded', segment, true);
      
      const data = await this.fetchSegmentCallback(segment, true);
      if (data) {
        this.queueSegmentForAppend(segment, data, 100, false); // Priority 100 = critical
      }
    }
  }

  /**
   * Prefetch segments theo prefetch_window
   */
  private async prefetchSegments(): Promise<void> {
    if (!this.currentQuality || !this.fetchSegmentCallback) return;

    const currentTime = this.videoElement.currentTime;
    const config = this.configManager.getConfig();

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
      if (this.appendedSegments.has(segmentKey)) continue;

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
      
      promises.push((async () => {
        this.emit('segmentNeeded', segment, false);
        const data = await this.fetchSegmentCallback!(segment, false);
        if (data) {
          const priority = 50 - Math.abs(segment.timestamp - currentTime); // Closer = higher priority
          this.queueSegmentForAppend(segment, data, priority, false);
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
        console.log(`[BufferManager] Waiting for segment ${this.nextExpectedSegmentId} to maintain sequence`);
        break;
      }

      const segmentKey = this.getSegmentKey(request.segment);

      try {
        // Append to MSE
        await this.mseManager.appendMediaSegment(request.data);
        
        this.appendedSegments.add(segmentKey);
        this.nextExpectedSegmentId = request.segment.id + 1;
        
        this.emit('segmentAppended', request.segment.id);
        
        console.log(
          `[BufferManager] Appended segment ${segmentKey} sequentially (next expected: ${this.nextExpectedSegmentId})`
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
        this.nextExpectedSegmentId = seekRequest.segment.id;
        return seekRequest;
      }
    }

    // Tìm segment có ID = nextExpectedSegmentId
    const exactMatch = this.appendQueue.find(
      req => req.segment.id === this.nextExpectedSegmentId
    );

    if (exactMatch) return exactMatch;

    // Nếu buffer rỗng hoặc sau seek, reset sequence với segment có priority cao nhất
    const status = this.getBufferStatus();
    if (status.buffered.length === 0 || this.isSeeking) {
      const highestPriority = this.appendQueue[0]; // Already sorted by priority
      if (highestPriority) {
        this.nextExpectedSegmentId = highestPriority.segment.id;
        return highestPriority;
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
    this.appendQueue = [];

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
      this.nextExpectedSegmentId = seekSegment.id;
    }

    this.isSeeking = false;

    // Prefetch segments xung quanh vị trí seek
    await this.prefetchSegmentsAroundSeek(seekTime);
  }

  /**
   * Handle waiting event (buffering)
   */
  private handleWaiting(): void {
    if (!this.isBuffering) {
      this.isBuffering = true;
      this.emit('bufferingStart');
      console.log('[BufferManager] Buffering started');
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
  mapTimeToSegmentId(time: number): number | null {
    const segment = this.findSegmentAtTime(time);
    return segment ? segment.id : null;
  }

  /**
   * Tìm segment tại thời điểm cụ thể
   */
  private findSegmentAtTime(time: number): SegmentMetadata | null {
    for (let i = 0; i < this.segments.length; i++) {
      const segment = this.segments[i];
      const nextSegment = this.segments[i + 1];
      
      const segmentStart = segment.timestamp;
      const segmentEnd = nextSegment ? nextSegment.timestamp : Infinity;
      
      if (time >= segmentStart && time < segmentEnd) {
        return segment;
      }
    }
    return null;
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

    // Clear append queue
    this.appendQueue = [];

    // Update quality và segments
    this.currentQuality = newQuality;
    this.segments = newSegments;

    // Append init segment của quality mới (bỏ qua nếu đã append bởi MSE manager)
    if (!skipInitAppend) {
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
    } else {
      console.log('[BufferManager] Skipping init append because MSE already appended it');
    }

    // Reset tracking (segments của quality mới chưa append)
    this.appendedSegments.clear();
    
    // Tìm segment tại vị trí hiện tại trong quality mới
    const currentTime = this.videoElement.currentTime;
    const currentSegment = this.findSegmentAtTime(currentTime);
    
    if (currentSegment) {
      this.nextExpectedSegmentId = currentSegment.id;
      const currentIndex = this.segments.indexOf(currentSegment);

      if (currentIndex !== -1) {
        await this.prefetchSegmentsForQualitySwitch(currentIndex);
      }
    }
  }

  /**
   * Prefetch the current and next segments immediately after a quality switch.
   * Ensures the timeline continues without gaps by fetching the segment that
   * covers the current playback position first, then a couple ahead.
   */
  private async prefetchSegmentsForQualitySwitch(currentIndex: number): Promise<void> {
    if (!this.fetchSegmentCallback) return;

    const maxAhead = 3; // current segment + next 2 to rebuild buffer quickly

    for (let offset = 0; offset < maxAhead; offset++) {
      const segment = this.segments[currentIndex + offset];
      if (!segment) break;

      const segmentKey = this.getSegmentKey(segment);
      if (this.appendedSegments.has(segmentKey)) continue;

      const isCritical = offset === 0;
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
   * Event listener registration
   */
  on<K extends keyof BufferManagerEvents>(event: K, listener: BufferManagerEvents[K]): void {
    this.eventListeners[event] = listener;
  }

  /**
   * Emit event
   */
  private emit<K extends keyof BufferManagerEvents>(
    event: K,
    ...args: Parameters<NonNullable<BufferManagerEvents[K]>>
  ): void {
    const listener = this.eventListeners[event];
    if (listener) {
      // @ts-expect-error - TypeScript has trouble with spread args
      listener(...args);
    }
  }

  /**
   * Cleanup
   */
  dispose(): void {
    this.stopMonitoring();
    this.appendQueue = [];
    this.appendedSegments.clear();
    this.segments = [];
    this.eventListeners = {};
    this.fetchSegmentCallback = null;
    console.log('[BufferManager] Disposed');
  }
}
