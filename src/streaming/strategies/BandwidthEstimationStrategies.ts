/**
 * Bandwidth Estimation Strategies
 * Different algorithms for estimating available bandwidth
 */

import type { IBandwidthEstimationStrategy } from '../interfaces/IAbrManager';

/**
 * Moving Average Bandwidth Estimation
 * Uses weighted moving average of recent samples
 */
export class MovingAverageBandwidthStrategy implements IBandwidthEstimationStrategy {
  readonly name = 'MovingAverage';

  private samples: Array<{ bandwidth: number; timestamp: number }> = [];
  private readonly windowSize: number;
  private readonly minSamples: number;

  constructor(windowSize = 5, minSamples = 2) {
    this.windowSize = windowSize;
    this.minSamples = minSamples;
  }

  addSample(bytes: number, latency: number): void {
    if (latency <= 0) return;

    // Calculate bandwidth in bps
    const bandwidth = (bytes * 8 * 1000) / latency; // bits per second

    this.samples.push({
      bandwidth,
      timestamp: Date.now(),
    });

    // Keep only recent samples
    if (this.samples.length > this.windowSize) {
      this.samples.shift();
    }
  }

  getEstimate(): number {
    if (this.samples.length < this.minSamples) {
      return 0; // Not enough data
    }

    // Calculate weighted moving average (more recent = higher weight)
    let totalWeight = 0;
    let weightedSum = 0;

    this.samples.forEach((sample, index) => {
      const weight = index + 1; // Linear weight: 1, 2, 3, 4, 5
      weightedSum += sample.bandwidth * weight;
      totalWeight += weight;
    });

    return weightedSum / totalWeight;
  }

  reset(): void {
    this.samples = [];
  }
}

/**
 * Exponential Weighted Moving Average (EWMA)
 * Gives exponentially decreasing weights to older samples
 */
export class EWMABandwidthStrategy implements IBandwidthEstimationStrategy {
  readonly name = 'EWMA';

  private estimate = 0;
  private alpha: number; // Smoothing factor (0-1)
  private sampleCount = 0;

  constructor(alpha = 0.3) {
    this.alpha = alpha; // 0.3 means 30% weight to new sample, 70% to history
  }

  addSample(bytes: number, latency: number): void {
    if (latency <= 0) return;

    const bandwidth = (bytes * 8 * 1000) / latency;

    if (this.sampleCount === 0) {
      this.estimate = bandwidth;
    } else {
      // EWMA formula: S_t = α * Y_t + (1 - α) * S_{t-1}
      this.estimate = this.alpha * bandwidth + (1 - this.alpha) * this.estimate;
    }

    this.sampleCount++;
  }

  getEstimate(): number {
    return this.estimate;
  }

  reset(): void {
    this.estimate = 0;
    this.sampleCount = 0;
  }
}

/**
 * Harmonic Mean Bandwidth Estimation
 * Better for averaging rates/speeds as it penalizes outliers
 */
export class HarmonicMeanBandwidthStrategy implements IBandwidthEstimationStrategy {
  readonly name = 'HarmonicMean';

  private samples: number[] = [];
  private readonly windowSize: number;

  constructor(windowSize = 5) {
    this.windowSize = windowSize;
  }

  addSample(bytes: number, latency: number): void {
    if (latency <= 0) return;

    const bandwidth = (bytes * 8 * 1000) / latency;
    this.samples.push(bandwidth);

    if (this.samples.length > this.windowSize) {
      this.samples.shift();
    }
  }

  getEstimate(): number {
    if (this.samples.length === 0) return 0;

    // Harmonic mean: n / (1/x1 + 1/x2 + ... + 1/xn)
    const reciprocalSum = this.samples.reduce((sum, bw) => sum + 1 / bw, 0);
    return this.samples.length / reciprocalSum;
  }

  reset(): void {
    this.samples = [];
  }
}

/**
 * Percentile-based Bandwidth Estimation
 * Uses a percentile of samples to avoid outliers
 */
export class PercentileBandwidthStrategy implements IBandwidthEstimationStrategy {
  readonly name = 'Percentile';

  private samples: number[] = [];
  private readonly windowSize: number;
  private readonly percentile: number; // 0-100

  constructor(windowSize = 10, percentile = 50) {
    this.windowSize = windowSize;
    this.percentile = percentile;
  }

  addSample(bytes: number, latency: number): void {
    if (latency <= 0) return;

    const bandwidth = (bytes * 8 * 1000) / latency;
    this.samples.push(bandwidth);

    if (this.samples.length > this.windowSize) {
      this.samples.shift();
    }
  }

  getEstimate(): number {
    if (this.samples.length === 0) return 0;

    // Sort samples
    const sorted = [...this.samples].sort((a, b) => a - b);

    // Calculate percentile index
    const index = Math.floor((this.percentile / 100) * sorted.length);
    return sorted[Math.min(index, sorted.length - 1)];
  }

  reset(): void {
    this.samples = [];
  }
}

/**
 * Adaptive Bandwidth Estimation
 * Automatically switches between strategies based on network conditions
 */
export class AdaptiveBandwidthStrategy implements IBandwidthEstimationStrategy {
  readonly name = 'Adaptive';

  private ewma: EWMABandwidthStrategy;
  private movingAvg: MovingAverageBandwidthStrategy;
  private recentVariance = 0;

  constructor() {
    this.ewma = new EWMABandwidthStrategy(0.3);
    this.movingAvg = new MovingAverageBandwidthStrategy(5);
  }

  addSample(bytes: number, latency: number): void {
    this.ewma.addSample(bytes, latency);
    this.movingAvg.addSample(bytes, latency);

    // Calculate variance (simplified)
    const ewmaEstimate = this.ewma.getEstimate();
    const avgEstimate = this.movingAvg.getEstimate();
    this.recentVariance = Math.abs(ewmaEstimate - avgEstimate) / Math.max(ewmaEstimate, 1);
  }

  getEstimate(): number {
    // Use EWMA for stable networks (low variance)
    // Use Moving Average for volatile networks (high variance)
    if (this.recentVariance < 0.2) {
      return this.ewma.getEstimate();
    } else {
      return this.movingAvg.getEstimate();
    }
  }

  reset(): void {
    this.ewma.reset();
    this.movingAvg.reset();
    this.recentVariance = 0;
  }
}
