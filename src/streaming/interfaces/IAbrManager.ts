/**
 * ABR (Adaptive Bitrate) Manager Interfaces
 * Applies Strategy Pattern and Single Responsibility Principle
 */

import type {
  Quality,
  MasterPlaylist,
  VariantPlaylist,
  InitSegment,
  BufferStatus,
} from '../types';

/**
 * Bandwidth Estimation Strategy Interface (Strategy Pattern)
 */
export interface IBandwidthEstimationStrategy {
  /**
   * Strategy name
   */
  readonly name: string;

  /**
   * Add sample for bandwidth calculation
   */
  addSample(bytes: number, latency: number): void;

  /**
   * Get estimated bandwidth in bps
   */
  getEstimate(): number;

  /**
   * Reset estimation
   */
  reset(): void;
}

/**
 * Quality Selection Strategy Interface (Strategy Pattern)
 */
export interface IQualitySelectionStrategy {
  /**
   * Strategy name
   */
  readonly name: string;

  /**
   * Select best quality based on conditions
   */
  selectQuality(
    availableQualities: Quality[],
    currentQuality: Quality | null,
    estimatedBandwidth: number,
    bufferStatus: BufferStatus
  ): Quality | null;

  /**
   * Check if should switch quality
   */
  shouldSwitchQuality(
    currentQuality: Quality,
    targetQuality: Quality,
    bufferStatus: BufferStatus
  ): boolean;
}

/**
 * Playlist Manager Interface (SRP - Playlist operations)
 */
export interface IPlaylistManager {
  /**
   * Load master playlist
   */
  loadMasterPlaylist(): Promise<MasterPlaylist>;

  /**
   * Load variant playlist for quality
   */
  loadVariantPlaylist(qualityId: string): Promise<VariantPlaylist>;

  /**
   * Get variant playlist
   */
  getVariantPlaylist(qualityId: string): VariantPlaylist | undefined;

  /**
   * Get all loaded variant playlists
   */
  getAllVariantPlaylists(): Map<string, VariantPlaylist>;

  /**
   * Clear playlist cache
   */
  clearPlaylists(): void;
}

/**
 * Init Segment Manager Interface (SRP - Init segment operations)
 */
export interface IInitSegmentManager {
  /**
   * Fetch init segment for quality
   */
  fetchInitSegment(qualityId: string): Promise<InitSegment>;

  /**
   * Get cached init segment
   */
  getInitSegment(qualityId: string): InitSegment | undefined;

  /**
   * Clear init segment cache
   */
  clearInitSegments(): void;
}

/**
 * Quality Switch Coordinator Interface (SRP - Quality switching)
 */
export interface IQualitySwitchCoordinator {
  /**
   * Execute quality switch
   */
  switchQuality(newQuality: Quality, reason: string): Promise<void>;

  /**
   * Check if currently switching
   */
  isSwitching(): boolean;

  /**
   * Get current quality
   */
  getCurrentQuality(): Quality | null;

  /**
   * Get available qualities
   */
  getAvailableQualities(): Quality[];
}

/**
 * Prefetch Coordinator Interface (SRP - Segment prefetching)
 */
export interface IPrefetchCoordinator {
  /**
   * Prefetch segments for current quality
   */
  prefetchSegments(currentTime: number, count: number): Promise<void>;

  /**
   * Prefetch segments around time (for seek)
   */
  prefetchAroundTime(time: number, ahead: number, behind: number): Promise<void>;

  /**
   * Cancel ongoing prefetch
   */
  cancelPrefetch(): void;

  /**
   * Get prefetched segments
   */
  getPrefetchedSegments(): Set<string>;
}

/**
 * Complete ABR Manager Interface
 */
export interface IAbrManager
  extends IQualitySwitchCoordinator,
    IPlaylistManager,
    IInitSegmentManager,
    IPrefetchCoordinator {
  /**
   * Initialize ABR manager
   */
  initialize(masterPlaylist: MasterPlaylist): Promise<void>;

  /**
   * Update bandwidth estimate
   */
  updateBandwidth(bytes: number, latency: number): void;

  /**
   * Check and perform ABR decision
   */
  checkAbrSwitch(bufferStatus: BufferStatus): Promise<void>;

  /**
   * Enable/disable ABR
   */
  setAbrEnabled(enabled: boolean): void;

  /**
   * Check if ABR is enabled
   */
  isAbrEnabled(): boolean;

  /**
   * Set bandwidth estimation strategy
   */
  setBandwidthStrategy(strategy: IBandwidthEstimationStrategy): void;

  /**
   * Set quality selection strategy
   */
  setQualityStrategy(strategy: IQualitySelectionStrategy): void;

  /**
   * Get estimated bandwidth
   */
  getEstimatedBandwidth(): number;

  /**
   * Clean up resources
   */
  destroy(): void;
}
