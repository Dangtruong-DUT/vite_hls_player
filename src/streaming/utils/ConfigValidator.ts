/**
 * Configuration Validator
 * Applies Single Responsibility Principle - handles only validation logic
 */

import type { StreamingConfig } from '../types';
import type { IConfigValidator } from '../interfaces/IConfigManager';

export class ConfigValidator implements IConfigValidator {
  /**
   * Validate full configuration
   * @throws Error if configuration is invalid
   */
  validate(config: StreamingConfig): void {
    this.validatePeerSettings(config);
    this.validateBufferSettings(config);
    this.validateAbrSettings(config);
    this.validateCacheSettings(config);
    this.validateFetchSettings(config);
    this.validateSignalingSettings(config);
  }

  /**
   * Validate peer settings
   */
  private validatePeerSettings(config: StreamingConfig): void {
    if (config.maxActivePeers < config.minActivePeers) {
      throw new Error('maxActivePeers must be >= minActivePeers');
    }

    if (config.minActivePeers < 0) {
      throw new Error('minActivePeers must be >= 0');
    }

    if (config.peerScoreThreshold < 0 || config.peerScoreThreshold > 1) {
      throw new Error('peerScoreThreshold must be between 0 and 1');
    }

    if (config.peerConnectionTimeout < 0) {
      throw new Error('peerConnectionTimeout must be >= 0');
    }
  }

  /**
   * Validate buffer settings
   */
  private validateBufferSettings(config: StreamingConfig): void {
    if (config.bufferMinThreshold >= config.bufferMaxThreshold) {
      throw new Error('bufferMinThreshold must be < bufferMaxThreshold');
    }

    if (config.bufferTargetDuration < 0) {
      throw new Error('bufferTargetDuration must be >= 0');
    }

    if (config.prefetchWindowAhead <= 0) {
      throw new Error('prefetchWindowAhead must be > 0');
    }

    if (config.prefetchWindowBehind < 0) {
      throw new Error('prefetchWindowBehind must be >= 0');
    }

    if (config.minBufferPrefetch < 0) {
      throw new Error('minBufferPrefetch must be >= 0');
    }
  }

  /**
   * Validate ABR settings
   */
  private validateAbrSettings(config: StreamingConfig): void {
    if (config.abrSwitchUpThreshold <= config.abrSwitchDownThreshold) {
      throw new Error('abrSwitchUpThreshold must be > abrSwitchDownThreshold');
    }

    if (
      config.abrSwitchUpThreshold < 0 ||
      config.abrSwitchUpThreshold > 1 ||
      config.abrSwitchDownThreshold < 0 ||
      config.abrSwitchDownThreshold > 1
    ) {
      throw new Error('ABR thresholds must be between 0 and 1');
    }

    if (config.bandwidthEstimationWindow < 1) {
      throw new Error('bandwidthEstimationWindow must be >= 1');
    }
  }

  /**
   * Validate cache settings
   */
  private validateCacheSettings(config: StreamingConfig): void {
    if (config.cacheSizeLimit <= 0) {
      throw new Error('cacheSizeLimit must be > 0');
    }

    if (config.cacheSegmentTTL <= 0) {
      throw new Error('cacheSegmentTTL must be > 0');
    }

    if (config.cachePlaylistTTL <= 0) {
      throw new Error('cachePlaylistTTL must be > 0');
    }

    if (config.cacheInitSegmentTTL <= 0) {
      throw new Error('cacheInitSegmentTTL must be > 0');
    }
  }

  /**
   * Validate fetch settings
   */
  private validateFetchSettings(config: StreamingConfig): void {
    if (config.maxConcurrentFetches < 1) {
      throw new Error('maxConcurrentFetches must be >= 1');
    }

    if (config.maxRetries < 0) {
      throw new Error('maxRetries must be >= 0');
    }

    if (config.fetchTimeout <= 0) {
      throw new Error('fetchTimeout must be > 0');
    }

    if (config.retryDelayBase < 0) {
      throw new Error('retryDelayBase must be >= 0');
    }

    if (config.staggeredRequestDelay < 0) {
      throw new Error('staggeredRequestDelay must be >= 0');
    }

    if (config.segmentRequestWaitMin < 0) {
      throw new Error('segmentRequestWaitMin must be >= 0');
    }

    if (config.segmentRequestWaitMax < config.segmentRequestWaitMin) {
      throw new Error('segmentRequestWaitMax must be >= segmentRequestWaitMin');
    }
  }

  /**
   * Validate signaling settings
   */
  private validateSignalingSettings(config: StreamingConfig): void {
    if (config.signalingReconnectInterval <= 0) {
      throw new Error('signalingReconnectInterval must be > 0');
    }

    if (config.signalingHeartbeatInterval < 0) {
      throw new Error('signalingHeartbeatInterval must be >= 0');
    }

    if (config.whoHasTimeout <= 0) {
      throw new Error('whoHasTimeout must be > 0');
    }
  }
}
