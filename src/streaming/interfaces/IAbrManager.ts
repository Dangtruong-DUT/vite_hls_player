import type {
  Quality,
  MasterPlaylist,
  BufferStatus,
} from '../types';

export interface IBandwidthEstimationStrategy {
  readonly name: string;
  addSample(bytes: number, latency: number): void;
  getEstimate(): number;
  reset(): void;
}

export interface IQualitySelectionStrategy {
  readonly name: string;
  selectQuality(
    availableQualities: Quality[],
    currentQuality: Quality | null,
    estimatedBandwidth: number,
    bufferStatus: BufferStatus
  ): Quality | null;
  shouldSwitchQuality(
    currentQuality: Quality,
    targetQuality: Quality,
    bufferStatus: BufferStatus
  ): boolean;
}

export interface IAbrManager {
  initialize(masterPlaylist: MasterPlaylist): Promise<void>;
  setBandwidthStrategy(strategy: IBandwidthEstimationStrategy): void;
  setQualityStrategy(strategy: IQualitySelectionStrategy): void;
  getEstimatedBandwidth(): number;
  destroy(): void;
}
