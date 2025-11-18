/**
 * Strategies Export
 * Central export point for all strategy implementations
 */

// Cache Eviction Strategies
export {
  LRUEvictionStrategy,
  LFUEvictionStrategy,
  TTLEvictionStrategy,
  SizeEvictionStrategy,
  CompositeEvictionStrategy,
} from './CacheEvictionStrategies';

// Bandwidth Estimation Strategies
export {
  MovingAverageBandwidthStrategy,
  EWMABandwidthStrategy,
  HarmonicMeanBandwidthStrategy,
  PercentileBandwidthStrategy,
  AdaptiveBandwidthStrategy,
} from './BandwidthEstimationStrategies';

// Quality Selection Strategies
export {
  ConservativeQualityStrategy,
  AggressiveQualityStrategy,
  BufferBasedQualityStrategy,
  HybridQualityStrategy,
  BOLAQualityStrategy,
} from './QualitySelectionStrategies';
