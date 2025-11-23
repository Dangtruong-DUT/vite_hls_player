import type { SegmentMetadata, BufferStatus, Quality } from '../types';

export interface IBufferManager {
  initialize(quality: Quality, segments: SegmentMetadata[]): Promise<void>;
  updateQuality(quality: Quality, segments: SegmentMetadata[]): Promise<void>;
  startMonitoring(): void;
  stopMonitoring(): void;
  getBufferStatus(): BufferStatus;
  handleSeek(targetTime: number): Promise<void>;
  setFetchCallback(
    callback: (segment: SegmentMetadata, critical: boolean) => Promise<ArrayBuffer | null>
  ): void;
  destroy(): void;
}
