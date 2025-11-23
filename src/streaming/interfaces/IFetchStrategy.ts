import type {
  SegmentMetadata,
  FetchResult,
  FetchSource,
  InitSegment,
  MasterPlaylist,
  VariantPlaylist,
} from '../types';

export interface IFetchStrategy {
  readonly name: FetchSource;
  readonly priority: number;
  canHandle(segment: SegmentMetadata, critical?: boolean): Promise<boolean>;
  fetch(segment: SegmentMetadata, timeout: number): Promise<FetchResult>;
  cancel?(segment: SegmentMetadata): void;
}

export interface ISegmentFetcher {
  fetchMediaSegment(segment: SegmentMetadata, options?: {
    timeout?: number;
    retries?: number;
    priority?: number;
    preferPeer?: boolean;
  }): Promise<FetchResult>;
  fetchInitSegment(qualityId: string): Promise<InitSegment>;
  fetchMasterPlaylist(): Promise<MasterPlaylist>;
  fetchVariantPlaylist(qualityId: string): Promise<VariantPlaylist>;
  fetchSegments(
    segments: SegmentMetadata[],
    options?: {
      timeout?: number;
      retries?: number;
      priority?: number;
    }
  ): Promise<Map<string, FetchResult>>;
  cancelFetch(qualityId: string, segmentId: string): void;
  cancelAllFetches(): void;
}
