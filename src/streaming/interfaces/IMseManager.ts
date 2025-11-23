import type { Quality, InitSegment, BufferRange } from '../types';

export interface IMseManager {
  initialize(mimeType?: string): Promise<void>;
  appendInitSegment(initSegment: InitSegment): Promise<void>;
  appendMediaSegment(data: ArrayBuffer): Promise<void>;
  isInitSegmentAppended(): boolean;
  isUpdating(): boolean;
  getBufferedRanges(): BufferRange[];
  removeBufferRange(start: number, end: number): Promise<void>;
  abort(): void;
  setDuration(duration: number): void;
  endOfStream(): Promise<void>;
  isSourceOpen(): boolean;
  getReadyState(): 'closed' | 'open' | 'ended';
  destroy(): void;
  getState(): 'playing' | 'paused' | 'buffering' | 'ended';
  play(): Promise<void>;
  pause(): void;
  seek(time: number): void;
  getCurrentTime(): number;
  getDuration(): number;
  isEnded(): boolean;
  getCurrentQuality(): Quality | null;
  setCurrentQuality(quality: Quality): void;
}
