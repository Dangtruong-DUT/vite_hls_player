/**
 * MSE (Media Source Extensions) Interfaces
 * Applies Single Responsibility Principle
 */

import type { Quality, InitSegment, BufferRange } from '../types';

/**
 * Source Buffer Manager Interface (SRP - Buffer management)
 */
export interface ISourceBufferManager {
  /**
   * Append initialization segment
   */
  appendInitSegment(initSegment: InitSegment): Promise<void>;

  /**
   * Append media segment
   */
  appendMediaSegment(data: ArrayBuffer): Promise<void>;

  /**
   * Check if init segment is appended
   */
  isInitSegmentAppended(): boolean;

  /**
   * Check if buffer is updating
   */
  isUpdating(): boolean;

  /**
   * Get buffered ranges
   */
  getBufferedRanges(): BufferRange[];

  /**
   * Remove buffer range
   */
  removeBufferRange(start: number, end: number): Promise<void>;

  /**
   * Abort current operation
   */
  abort(): void;
}

/**
 * Media Source Controller Interface (SRP - MediaSource lifecycle)
 */
export interface IMediaSourceController {
  /**
   * Initialize MediaSource
   */
  initialize(mimeType?: string): Promise<void>;

  /**
   * Set duration
   */
  setDuration(duration: number): void;

  /**
   * End stream
   */
  endOfStream(): Promise<void>;

  /**
   * Check if source is open
   */
  isSourceOpen(): boolean;

  /**
   * Get ready state
   */
  getReadyState(): 'closed' | 'open' | 'ended';

  /**
   * Clean up resources
   */
  destroy(): void;
}

/**
 * Playback State Manager Interface (SRP - Playback state)
 */
export interface IPlaybackStateManager {
  /**
   * Get current playback state
   */
  getState(): 'playing' | 'paused' | 'buffering' | 'ended';

  /**
   * Update playback state
   */
  updateState(state: 'playing' | 'paused' | 'buffering' | 'ended'): void;

  /**
   * Play video
   */
  play(): Promise<void>;

  /**
   * Pause video
   */
  pause(): void;

  /**
   * Seek to time
   */
  seek(time: number): void;

  /**
   * Get current time
   */
  getCurrentTime(): number;

  /**
   * Get duration
   */
  getDuration(): number;

  /**
   * Check if ended
   */
  isEnded(): boolean;
}

/**
 * MSE Manager Interface (Facade for all MSE operations)
 */
export interface IMseManager
  extends IMediaSourceController,
    ISourceBufferManager,
    IPlaybackStateManager {
  /**
   * Get current quality
   */
  getCurrentQuality(): Quality | null;

  /**
   * Set current quality
   */
  setCurrentQuality(quality: Quality): void;
}
