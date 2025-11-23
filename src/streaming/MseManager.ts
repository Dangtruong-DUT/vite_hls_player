import type { Quality, InitSegment, BufferRange } from './types';
import type { IMseManager } from './interfaces/IMseManager';
import { EventEmitter } from './interfaces/IEventEmitter';
import { APP_CONSTANTS } from './ConfigManager';

export interface MseManagerEvents {
  sourceOpen: () => void;
  sourceClose: () => void;
  updateEnd: () => void;
  error: (error: Error) => void;
  qualityChanged: (quality: Quality) => void;
  durationChanged: (duration: number) => void;
  playbackStateChanged: (state: 'playing' | 'paused' | 'buffering' | 'ended') => void;
  seekStart: (targetTime: number) => void;
  seekEnd: (targetTime: number) => void;
  [event: string]: (...args: any[]) => void;
}

/**
 * MseManager implementing IMseManager interface
 * Extends EventEmitter for event handling
 */
export class MseManager extends EventEmitter<MseManagerEvents> implements IMseManager {
  private mediaSource: MediaSource | null = null;
  private sourceBuffer: SourceBuffer | null = null;
  private videoElement: HTMLVideoElement;

  private currentQuality: Quality | null = null;
  private initSegment: InitSegment | null = null;
  private totalDuration = 0;

  private isInitialized = false;
  private initSegmentAppended = false;
  private pendingSegments: ArrayBuffer[] = [];
  private isAppending = false;
  private objectUrl: string | null = null;

  private playbackState: 'playing' | 'paused' | 'buffering' | 'ended' = 'paused';

  constructor(videoElement: HTMLVideoElement) {
    super(); // Call EventEmitter constructor
    this.videoElement = videoElement;
    this.setupVideoEventListeners();
  }

  /**
   * Setup video element event listeners
   */
  private setupVideoEventListeners(): void {
    this.videoElement.addEventListener('play', () => {
      this.updatePlaybackState('playing');
    });

    this.videoElement.addEventListener('pause', () => {
      if (!this.videoElement.ended) {
        this.updatePlaybackState('paused');
      }
    });

    this.videoElement.addEventListener('ended', () => {
      this.updatePlaybackState('ended');
    });

    this.videoElement.addEventListener('waiting', () => {
      // Không buffering nếu video đã kết thúc hoặc đang pause
      if (!this.videoElement.paused && !this.videoElement.ended) {
        this.updatePlaybackState('buffering');
      }
    });

    this.videoElement.addEventListener('canplay', () => {
      // Không chuyển sang playing nếu video đã kết thúc
      if (!this.videoElement.paused && !this.videoElement.ended) {
        this.updatePlaybackState('playing');
      }
    });

    this.videoElement.addEventListener('seeking', () => {
      const targetTime = this.videoElement.currentTime;
      this.emit('seekStart', targetTime);
      console.log(`[MseManager] Seeking to ${targetTime.toFixed(2)}s`);
    });

    this.videoElement.addEventListener('seeked', () => {
      const targetTime = this.videoElement.currentTime;
      this.emit('seekEnd', targetTime);
      console.log(`[MseManager] Seeked to ${targetTime.toFixed(2)}s`);
    });
  }

  /**
   * Update playback state
   */
  private updatePlaybackState(state: 'playing' | 'paused' | 'buffering' | 'ended'): void {
    if (this.playbackState !== state) {
      this.playbackState = state;
      this.emit('playbackStateChanged', state);
      console.log(`[MseManager] Playback state: ${state}`);
    }
  }

  /**
   * Initialize MediaSource và attach to video element
   */
  async initialize(mimeType: string = APP_CONSTANTS.MIME_TYPES.DEFAULT_VIDEO): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        // Check MediaSource support
        if (!window.MediaSource || !MediaSource.isTypeSupported(mimeType)) {
          throw new Error(`MediaSource not supported or codec not supported: ${mimeType}`);
        }

        // Create MediaSource
        this.mediaSource = new MediaSource();
        this.objectUrl = URL.createObjectURL(this.mediaSource);
        this.videoElement.src = this.objectUrl;

        // Wait for sourceopen
        this.mediaSource.addEventListener('sourceopen', () => {
          try {
            if (!this.mediaSource) {
              throw new Error('MediaSource is null');
            }

            // Create SourceBuffer
            this.sourceBuffer = this.mediaSource.addSourceBuffer(mimeType);

            // SourceBuffer event listeners
            this.sourceBuffer.addEventListener('updateend', () => {
              this.isAppending = false;
              this.emit('updateEnd');
              this.processQueue();
            });

            this.sourceBuffer.addEventListener('error', (e) => {
              console.error('[MseManager] SourceBuffer error:', e);
              this.emit('error', new Error('SourceBuffer error'));
            });

            this.isInitialized = true;
            this.emit('sourceOpen');
            console.log('[MseManager] MediaSource initialized');
            resolve();
          } catch (error) {
            reject(error);
          }
        });

        this.mediaSource.addEventListener('sourceclose', () => {
          this.emit('sourceClose');
          console.log('[MseManager] MediaSource closed');
        });

        this.mediaSource.addEventListener('sourceended', () => {
          console.log('[MseManager] MediaSource ended');
        });

      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Set total duration từ playlist (TRƯỚC KHI APPEND)
   */
  setDuration(duration: number): void {
    this.totalDuration = duration;

    if (this.mediaSource && this.mediaSource.readyState === 'open') {
      try {
        this.mediaSource.duration = duration;
        this.emit('durationChanged', duration);
        console.log(`[MseManager] Duration set to ${duration.toFixed(2)}s`);
      } catch (error) {
        console.warn('[MseManager] Failed to set duration:', error);
      }
    }
  }

  /**
   * Append initialization segment (TRƯỚC KHI APPEND MEDIA)
   * Không thay đổi timestampOffset khi switch quality để giữ nguyên timeline
   */
  async appendInitSegment(initSegment: InitSegment): Promise<void> {
    if (!this.isInitialized || !this.sourceBuffer) {
      throw new Error('MSE not initialized');
    }

    console.log(`[MseManager] Appending init segment for quality ${initSegment.qualityId}`);

    this.initSegment = initSegment;
    this.initSegmentAppended = false;

    // Wait for any pending updates before appending init
    if (this.sourceBuffer.updating) {
      await this.waitForUpdateEnd();
    }

    // KHÔNG thay đổi timestampOffset khi switch quality
    // Timeline sẽ tiếp tục từ vị trí hiện tại
    // timestampOffset chỉ được set khi khởi tạo lần đầu hoặc seek
    console.log(`[MseManager] Current timestampOffset: ${this.sourceBuffer.timestampOffset.toFixed(2)}s`);

    await this.appendBuffer(initSegment.data);

    this.initSegmentAppended = true;
    console.log(`[MseManager] Init segment appended for quality ${initSegment.qualityId}`);
  }

  /**
   * Append media segment (TUẦN TỰ)
   */
  async appendMediaSegment(data: ArrayBuffer): Promise<void> {
    if (!this.isInitialized || !this.sourceBuffer) {
      throw new Error('MSE not initialized');
    }

    if (!this.initSegmentAppended) {
      throw new Error('Init segment not appended yet - must append init segment first');
    }

    return this.appendBuffer(data);
  }

  /**
   * Append buffer với queueing (tuần tự)
   */
  private async appendBuffer(data: ArrayBuffer): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.sourceBuffer) {
        reject(new Error('SourceBuffer not available'));
        return;
      }

      // Add to queue
      this.pendingSegments.push(data);

      // Create one-time listener
      const handleUpdateEnd = () => {
        this.sourceBuffer?.removeEventListener('updateend', handleUpdateEnd);
        resolve();
      };

      const handleError = (e: Event) => {
        this.sourceBuffer?.removeEventListener('error', handleError);
        console.error('[MseManager] Append error:', e);
        reject(new Error('Failed to append buffer'));
      };

      this.sourceBuffer.addEventListener('updateend', handleUpdateEnd, { once: true });
      this.sourceBuffer.addEventListener('error', handleError, { once: true });

      // Process queue
      this.processQueue();
    });
  }

  /**
   * Process pending segments queue (tuần tự)
   */
  private processQueue(): void {
    if (!this.sourceBuffer || this.isAppending || this.pendingSegments.length === 0) {
      return;
    }

    if (this.sourceBuffer.updating) {
      return;
    }

    const segment = this.pendingSegments.shift();
    if (segment) {
      try {
        this.isAppending = true;
        this.sourceBuffer.appendBuffer(segment);
      } catch (error) {
        console.error('[MseManager] Error appending buffer:', error);
        this.isAppending = false;
        this.emit('error', error as Error);
      }
    }
  }

  /**
   * ABR Quality Switch - Append init segment mới
   * Xóa buffer từ segment tiếp theo (không phải currentTime) để giữ nguyên timeline
   */
  async switchQuality(newQuality: Quality, newInitSegment: InitSegment): Promise<void> {
    if (!this.mediaSource || !this.sourceBuffer) {
      throw new Error('MSE not initialized');
    }

    console.log(`[MseManager] Switching quality: ${this.currentQuality?.id} → ${newQuality.id}`);

    // Wait for pending updates
    await this.waitForUpdateEnd();

    // Clear pending queue
    this.pendingSegments = [];

    // Xóa tất cả buffer sau currentTime để loại bỏ segment prefetch cũ
    const currentTime = this.videoElement.currentTime;
    const buffered = this.getBufferedRanges();
    
    // Giữ buffer một khoảng nhỏ sau currentTime để tránh gap (0.5s)
    const safeOffset = 0.5;

    for (const range of buffered) {
      // Xóa sau currentTime + safeOffset để đảm bảo không gây gap
      const removeStart = currentTime + safeOffset;
      
      if (range.end > removeStart && removeStart < range.end) {
        try {
          // Giữ buffer đến currentTime + safeOffset, xóa sau đó
          await this.removeBuffer(removeStart, range.end);
          console.log(`[MseManager] Removed buffer from ${removeStart.toFixed(2)}s to ${range.end.toFixed(2)}s (safe offset: ${safeOffset}s)`);
        } catch (error) {
          console.warn('[MseManager] Failed to remove buffer during quality switch:', error);
        }
      }
    }

    // Update quality
    this.currentQuality = newQuality;

    // Append init segment mới
    await this.appendInitSegment(newInitSegment);

    this.emit('qualityChanged', newQuality);
    console.log(`[MseManager] Quality switched to ${newQuality.id}, buffer cleared after currentTime`);
  }

  /**
   * Handle seek - Clear queue và prepare cho segments mới
   */
  async handleSeek(targetTime: number): Promise<void> {
    console.log(`[MseManager] Handling seek to ${targetTime.toFixed(2)}s`);

    // Clear pending segments
    this.pendingSegments = [];

    // Wait for current operation
    await this.waitForUpdateEnd();

    // Video element sẽ handle actual seek
    // BufferManager sẽ prefetch init + surrounding segments
  }

  /**
   * Prepare for seek - Fetch init segment + surrounding segments
   * (Gọi từ BufferManager)
   */
  async prepareForSeek(targetTime: number, initSegment: InitSegment): Promise<void> {
    console.log(`[MseManager] Preparing for seek to ${targetTime.toFixed(2)}s`);

    // Clear queue
    this.pendingSegments = [];
    await this.waitForUpdateEnd();

    // Append init segment nếu quality khác
    if (this.initSegment?.qualityId !== initSegment.qualityId) {
      await this.appendInitSegment(initSegment);
    }

    console.log(`[MseManager] Ready for seek to ${targetTime.toFixed(2)}s`);
  }

  /**
   * Remove buffer range (interface implementation)
   */
  async removeBufferRange(start: number, end: number): Promise<void> {
    return this.removeBuffer(start, end);
  }

  /**
   * Remove buffered data
   */
  async removeBuffer(start: number, end: number): Promise<void> {
    if (!this.sourceBuffer) {
      throw new Error('SourceBuffer not available');
    }

    await this.waitForUpdateEnd();

    return new Promise((resolve, reject) => {
      if (!this.sourceBuffer) {
        reject(new Error('SourceBuffer not available'));
        return;
      }

      const handleUpdateEnd = () => {
        this.sourceBuffer?.removeEventListener('updateend', handleUpdateEnd);
        resolve();
      };

      const handleError = () => {
        this.sourceBuffer?.removeEventListener('error', handleError);
        reject(new Error('Failed to remove buffer'));
      };

      this.sourceBuffer.addEventListener('updateend', handleUpdateEnd, { once: true });
      this.sourceBuffer.addEventListener('error', handleError, { once: true });

      try {
        this.sourceBuffer.remove(start, end);
      } catch (error) {
        this.sourceBuffer.removeEventListener('updateend', handleUpdateEnd);
        this.sourceBuffer.removeEventListener('error', handleError);
        reject(error);
      }
    });
  }

  /**
   * Playback control - Play
   */
  async play(): Promise<void> {
    if (!this.isInitialized) {
      throw new Error('MSE not initialized');
    }

    try {
      await this.videoElement.play();
      console.log('[MseManager] Playback started');
    } catch (error) {
      console.error('[MseManager] Play error:', error);
      throw error;
    }
  }

  /**
   * Playback control - Pause
   */
  pause(): void {
    if (!this.isInitialized) {
      throw new Error('MSE not initialized');
    }

    this.videoElement.pause();
    console.log('[MseManager] Playback paused');
  }

  /**
   * Playback control - Resume (alias for play)
   */
  async resume(): Promise<void> {
    return this.play();
  }

  /**
   * Seek to specific time
   */
  seek(time: number): void {
    if (!this.isInitialized) {
      throw new Error('MSE not initialized');
    }

    const duration = this.totalDuration || this.videoElement.duration;
    const targetTime = Math.max(0, Math.min(time, duration));

    console.log(`[MseManager] Seeking to ${targetTime.toFixed(2)}s`);
    this.videoElement.currentTime = targetTime;
  }

  /**
   * Get buffered time ranges
   */
  getBufferedRanges(): BufferRange[] {
    if (!this.sourceBuffer) {
      return [];
    }

    const ranges: BufferRange[] = [];
    const buffered = this.sourceBuffer.buffered;

    for (let i = 0; i < buffered.length; i++) {
      ranges.push({
        start: buffered.start(i),
        end: buffered.end(i),
      });
    }

    return ranges;
  }

  /**
   * Get buffered time ahead of current position
   */
  getBufferedAhead(currentTime?: number): number {
    const time = currentTime ?? this.videoElement.currentTime;
    const ranges = this.getBufferedRanges();

    for (const range of ranges) {
      if (time >= range.start && time <= range.end) {
        return range.end - time;
      }
    }

    return 0;
  }

  /**
   * Get buffered time behind current position
   */
  getBufferedBehind(currentTime?: number): number {
    const time = currentTime ?? this.videoElement.currentTime;
    const ranges = this.getBufferedRanges();

    for (const range of ranges) {
      if (time >= range.start && time <= range.end) {
        return time - range.start;
      }
    }

    return 0;
  }

  /**
   * Wait for SourceBuffer to finish updating
   */
  private async waitForUpdateEnd(): Promise<void> {
    if (!this.sourceBuffer || !this.sourceBuffer.updating) {
      return;
    }

    return new Promise((resolve) => {
      const checkUpdate = () => {
        if (!this.sourceBuffer?.updating) {
          resolve();
        } else {
          setTimeout(checkUpdate, 10);
        }
      };
      checkUpdate();
    });
  }

  /**
   * End of stream (call khi playback hoàn tất)
   */
  async endOfStream(): Promise<void> {
    if (!this.mediaSource || this.mediaSource.readyState !== 'open') {
      return;
    }

    await this.waitForUpdateEnd();

    try {
      this.mediaSource.endOfStream();
      console.log('[MseManager] End of stream signaled');
    } catch (error) {
      console.error('[MseManager] Error ending stream:', error);
    }
  }

  /**
   * Get current quality
   */
  getCurrentQuality(): Quality | null {
    return this.currentQuality;
  }

  /**
   * Get current playback state
   */
  getPlaybackState(): 'playing' | 'paused' | 'buffering' | 'ended' {
    return this.playbackState;
  }

  /**
   * Get current time
   */
  getCurrentTime(): number {
    return this.videoElement.currentTime;
  }

  /**
   * Get duration
   */
  getDuration(): number {
    return this.totalDuration || this.videoElement.duration || 0;
  }

  /**
   * Check if MSE is ready
   */
  isReady(): boolean {
    return this.isInitialized && this.sourceBuffer !== null;
  }

  /**
   * Check if init segment is appended
   */
  isInitSegmentAppended(): boolean {
    return this.initSegmentAppended;
  }

  setCurrentQuality(quality: Quality): void {
    const oldQuality = this.currentQuality;
    this.currentQuality = quality;
    if (oldQuality?.id !== quality.id) {
      this.emit('qualityChanged', quality);
    }
  }

  /**
   * Check if source is open (IMediaSourceController interface)
   */
  isSourceOpen(): boolean {
    return this.mediaSource?.readyState === 'open';
  }

  /**
   * Get ready state (IMediaSourceController interface)
   */
  getReadyState(): 'closed' | 'open' | 'ended' {
    return (this.mediaSource?.readyState as 'closed' | 'open' | 'ended') || 'closed';
  }

  /**
   * Get playback state (IPlaybackStateManager interface)
   */
  getState(): 'playing' | 'paused' | 'buffering' | 'ended' {
    return this.playbackState;
  }

  /**
   * Check if updating (ISourceBufferManager interface)
   */
  isUpdating(): boolean {
    return this.sourceBuffer?.updating || false;
  }

  /**
   * Abort any ongoing operations (ISourceBufferManager interface)
   */
  abort(): void {
    if (this.sourceBuffer && !this.sourceBuffer.updating) {
      try {
        this.sourceBuffer.abort();
        this.pendingSegments = [];
        console.log('[MseManager] SourceBuffer aborted');
      } catch (error) {
        console.error('[MseManager] Error aborting SourceBuffer:', error);
      }
    }
  }

  /**
   * Check if playback has ended (IPlaybackStateManager interface)
   */
  isEnded(): boolean {
    return this.videoElement.ended;
  }

  destroy(): void {
    console.log('[MseManager] Disposing');

    // Clear queue
    this.pendingSegments = [];

    // Remove source buffer
    if (this.mediaSource && this.sourceBuffer) {
      try {
        if (this.mediaSource.readyState === 'open') {
          this.mediaSource.removeSourceBuffer(this.sourceBuffer);
        }
      } catch (error) {
        console.error('[MseManager] Error removing source buffer:', error);
      }
    }

    // Revoke object URL
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }

    // Clear video source
    this.videoElement.removeAttribute('src');
    this.videoElement.load();

    // Reset state
    this.sourceBuffer = null;
    this.mediaSource = null;
    this.currentQuality = null;
    this.initSegment = null;
    this.isInitialized = false;
    this.initSegmentAppended = false;
    this.isAppending = false;
    this.totalDuration = 0;
    this.playbackState = 'paused';
  }
}
