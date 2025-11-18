/**
 * Quality Selection Strategies
 * Different algorithms for selecting optimal video quality
 */

import type { IQualitySelectionStrategy } from '../interfaces/IAbrManager';
import type { Quality, BufferStatus } from '../types';

/**
 * Conservative Quality Selection
 * Switches quality conservatively to avoid buffering
 */
export class ConservativeQualityStrategy implements IQualitySelectionStrategy {
  readonly name = 'Conservative';

  private readonly safetyMargin = 1.5; // Require 1.5x bandwidth for quality
  private readonly switchUpBufferThreshold = 0.8; // 80% buffer to switch up
  private readonly switchDownBufferThreshold = 0.3; // 30% buffer to switch down

  selectQuality(
    availableQualities: Quality[],
    currentQuality: Quality | null,
    estimatedBandwidth: number,
    bufferStatus: BufferStatus
  ): Quality | null {
    if (availableQualities.length === 0) return null;
    if (estimatedBandwidth === 0) return availableQualities[0]; // Lowest quality

    // Sort qualities by bandwidth (ascending)
    const sorted = [...availableQualities].sort((a, b) => a.bandwidth - b.bandwidth);

    // Calculate safe bandwidth (with margin)
    const safeBandwidth = estimatedBandwidth / this.safetyMargin;

    // Find highest quality within safe bandwidth
    let selectedQuality = sorted[0];
    for (const quality of sorted) {
      if (quality.bandwidth <= safeBandwidth) {
        selectedQuality = quality;
      } else {
        break;
      }
    }

    // If buffer is low, prefer lower quality
    const bufferRatio = bufferStatus.bufferAhead / (bufferStatus.duration || 1);
    if (bufferRatio < this.switchDownBufferThreshold && currentQuality) {
      const currentIndex = sorted.findIndex((q) => q.id === currentQuality.id);
      if (currentIndex > 0) {
        selectedQuality = sorted[Math.max(0, currentIndex - 1)];
      }
    }

    return selectedQuality;
  }

  shouldSwitchQuality(
    currentQuality: Quality,
    targetQuality: Quality,
    bufferStatus: BufferStatus
  ): boolean {
    if (currentQuality.id === targetQuality.id) return false;

    const bufferRatio = bufferStatus.bufferAhead / (bufferStatus.duration || 1);

    // Switching up requires good buffer
    if (targetQuality.bandwidth > currentQuality.bandwidth) {
      return bufferRatio >= this.switchUpBufferThreshold;
    }

    // Switching down is always allowed (safety)
    return true;
  }
}

/**
 * Aggressive Quality Selection
 * Maximizes quality more aggressively
 */
export class AggressiveQualityStrategy implements IQualitySelectionStrategy {
  readonly name = 'Aggressive';

  private readonly safetyMargin = 1.2; // Require 1.2x bandwidth
  private readonly switchUpBufferThreshold = 0.5; // 50% buffer to switch up
  private readonly switchDownBufferThreshold = 0.2; // 20% buffer to switch down

  selectQuality(
    availableQualities: Quality[],
    _currentQuality: Quality | null,
    estimatedBandwidth: number,
    _bufferStatus: BufferStatus
  ): Quality | null {
    if (availableQualities.length === 0) return null;
    if (estimatedBandwidth === 0) return availableQualities[0];

    const sorted = [...availableQualities].sort((a, b) => a.bandwidth - b.bandwidth);
    const safeBandwidth = estimatedBandwidth / this.safetyMargin;

    // Find highest quality within safe bandwidth
    let selectedQuality = sorted[0];
    for (const quality of sorted) {
      if (quality.bandwidth <= safeBandwidth) {
        selectedQuality = quality;
      } else {
        break;
      }
    }

    return selectedQuality;
  }

  shouldSwitchQuality(
    currentQuality: Quality,
    targetQuality: Quality,
    bufferStatus: BufferStatus
  ): boolean {
    if (currentQuality.id === targetQuality.id) return false;

    const bufferRatio = bufferStatus.bufferAhead / (bufferStatus.duration || 1);

    if (targetQuality.bandwidth > currentQuality.bandwidth) {
      return bufferRatio >= this.switchUpBufferThreshold;
    }

    if (targetQuality.bandwidth < currentQuality.bandwidth) {
      return bufferRatio < this.switchDownBufferThreshold;
    }

    return false;
  }
}

/**
 * Buffer-based Quality Selection
 * Primarily uses buffer status to decide quality
 */
export class BufferBasedQualityStrategy implements IQualitySelectionStrategy {
  readonly name = 'BufferBased';

  selectQuality(
    availableQualities: Quality[],
    _currentQuality: Quality | null,
    estimatedBandwidth: number,
    bufferStatus: BufferStatus
  ): Quality | null {
    if (availableQualities.length === 0) return null;

    const sorted = [...availableQualities].sort((a, b) => a.bandwidth - b.bandwidth);
    const bufferRatio = bufferStatus.bufferAhead / (bufferStatus.duration || 1);

    // Map buffer ratio to quality index
    // More buffer = higher quality
    const targetIndex = Math.min(
      Math.floor(bufferRatio * sorted.length),
      sorted.length - 1
    );

    // Also consider bandwidth
    const safeBandwidth = estimatedBandwidth / 1.3;
    let selectedQuality = sorted[targetIndex];

    // Ensure quality is within bandwidth limits
    if (selectedQuality.bandwidth > safeBandwidth) {
      for (let i = targetIndex; i >= 0; i--) {
        if (sorted[i].bandwidth <= safeBandwidth) {
          selectedQuality = sorted[i];
          break;
        }
      }
    }

    return selectedQuality;
  }

  shouldSwitchQuality(
    currentQuality: Quality,
    targetQuality: Quality,
    _bufferStatus: BufferStatus
  ): boolean {
    // Buffer-based strategy switches more frequently
    return currentQuality.id !== targetQuality.id;
  }
}

/**
 * Hybrid Quality Selection
 * Combines bandwidth and buffer considerations
 */
export class HybridQualityStrategy implements IQualitySelectionStrategy {
  readonly name = 'Hybrid';

  private readonly bandwidthWeight = 0.6;
  private readonly bufferWeight = 0.4;

  selectQuality(
    availableQualities: Quality[],
    _currentQuality: Quality | null,
    estimatedBandwidth: number,
    bufferStatus: BufferStatus
  ): Quality | null {
    if (availableQualities.length === 0) return null;

    const sorted = [...availableQualities].sort((a, b) => a.bandwidth - b.bandwidth);

    // Calculate bandwidth score (0-1)
    const maxBandwidth = sorted[sorted.length - 1].bandwidth;
    const safeBandwidth = estimatedBandwidth / 1.4;
    const bandwidthScore = Math.min(safeBandwidth / maxBandwidth, 1);

    // Calculate buffer score (0-1)
    const bufferRatio = Math.min(bufferStatus.bufferAhead / 30, 1); // Normalize to 30s

    // Weighted combination
    const combinedScore =
      bandwidthScore * this.bandwidthWeight + bufferRatio * this.bufferWeight;

    // Map score to quality index
    const targetIndex = Math.min(
      Math.floor(combinedScore * sorted.length),
      sorted.length - 1
    );

    return sorted[Math.max(0, targetIndex)];
  }

  shouldSwitchQuality(
    currentQuality: Quality,
    targetQuality: Quality,
    bufferStatus: BufferStatus
  ): boolean {
    if (currentQuality.id === targetQuality.id) return false;

    const bufferRatio = bufferStatus.bufferAhead / (bufferStatus.duration || 1);

    // Switching up requires reasonable buffer
    if (targetQuality.bandwidth > currentQuality.bandwidth) {
      return bufferRatio >= 0.6;
    }

    // Switching down requires low buffer or bandwidth issue
    return bufferRatio < 0.4;
  }
}

/**
 * BOLA (Buffer Occupancy based Lyapunov Algorithm)
 * Advanced quality selection based on buffer occupancy
 */
export class BOLAQualityStrategy implements IQualitySelectionStrategy {
  readonly name = 'BOLA';

  private readonly minBufferLevel = 5; // seconds
  private readonly maxBufferLevel = 30; // seconds

  selectQuality(
    availableQualities: Quality[],
    _currentQuality: Quality | null,
    estimatedBandwidth: number,
    bufferStatus: BufferStatus
  ): Quality | null {
    if (availableQualities.length === 0) return null;

    const sorted = [...availableQualities].sort((a, b) => a.bandwidth - b.bandwidth);
    const buffer = bufferStatus.bufferAhead;

    // BOLA utility calculation
    let bestQuality = sorted[0];
    let maxUtility = -Infinity;

    for (const quality of sorted) {
      // Utility = (V * (log(bitrate) - log(min_bitrate))) - buffer * bitrate
      const V = (this.maxBufferLevel - this.minBufferLevel) / Math.log(2);
      const utility =
        V * Math.log(quality.bandwidth / sorted[0].bandwidth) -
        buffer * (quality.bandwidth / 1000000); // Normalize

      if (utility > maxUtility && quality.bandwidth <= estimatedBandwidth * 0.8) {
        maxUtility = utility;
        bestQuality = quality;
      }
    }

    return bestQuality;
  }

  shouldSwitchQuality(
    currentQuality: Quality,
    targetQuality: Quality,
    bufferStatus: BufferStatus
  ): boolean {
    if (currentQuality.id === targetQuality.id) return false;

    // BOLA allows switches based on buffer level
    return bufferStatus.bufferAhead >= this.minBufferLevel;
  }
}
