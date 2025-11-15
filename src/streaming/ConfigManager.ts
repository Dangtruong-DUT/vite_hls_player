/**
 * Configuration Manager
 * Centralized configuration for streaming player with default values and validation
 */

import type { StreamingConfig } from './types';

export const DEFAULT_CONFIG: StreamingConfig = {
  // Peer settings
  maxActivePeers: 6,
  minActivePeers: 2,
  peerConnectionTimeout: 5000, // 5s - reduced from 10s for faster fallback
  peerScoreThreshold: 0.3, // Minimum score to keep connection

  // Buffer settings
  prefetchWindowAhead: 60, // 60 seconds ahead of playback position (expanded from 30s)
  prefetchWindowBehind: 20, // 20 seconds behind during seek (expanded from 10s)
  bufferTargetDuration: 30, // Target 30s of buffer (expanded from 20s)
  bufferMinThreshold: 8, // Critical buffer threshold - start buffering if below 8s (expanded from 5s)
  bufferMaxThreshold: 120, // Stop prefetching if above 120s (expanded from 60s)
  minBufferPrefetch: 5, // Minimum 5s buffer before starting prefetch (expanded from 3s)

  // ABR settings
  abrEnabled: true,
  abrSwitchUpThreshold: 0.8, // Switch up if buffer > 80%
  abrSwitchDownThreshold: 0.3, // Switch down if buffer < 30%
  bandwidthEstimationWindow: 5, // Use last 5 segments for bandwidth estimation

  // Cache settings
  cacheSizeLimit: 1024 * 1024 * 1024, // 1GB (expanded from 500MB)
  cacheSegmentTTL: 15 * 60 * 1000, // 15 minutes (expanded from 5 minutes)
  cachePlaylistTTL: 5 * 60 * 1000, // 5 minutes (expanded from 1 minute)
  cacheInitSegmentTTL: 60 * 60 * 1000, // 60 minutes (expanded from 30 minutes)

  // Fetch settings
  maxConcurrentFetches: 6, // 6 concurrent fetches (expanded from 4)
  fetchTimeout: 5000, // 5s - reduced from 8s for faster fallback
  maxRetries: 2, // Reduced from 3 to 2 for faster fallback
  retryDelayBase: 300, // 300ms, reduced from 500ms
  staggeredRequestDelay: 100, // 100ms between peer requests
  segmentRequestWaitMin: 50, // Minimum 50ms wait before sending segment request
  segmentRequestWaitMax: 200, // Maximum 200ms wait before sending segment request

  // Signaling settings
  signalingReconnectInterval: 5000, // 5s
  signalingHeartbeatInterval: 0, // 0 = disabled (let WebSocket handle keep-alive)
  whoHasTimeout: 2000, // 2s - reduced from 3s for faster fallback

  // Seek optimization settings
  seekPrefetchAhead: 10, // Prefetch 10 segments ahead on seek (expanded from 5)
  seekPrefetchBehind: 5, // Prefetch 5 segments behind on seek (expanded from 2)

  // API endpoints
  baseUrl: import.meta.env.VITE_BASE_URL || 'http://localhost:8080/api/v1',
};

export class ConfigManager {
  private config: StreamingConfig;
  private listeners: Set<(config: StreamingConfig) => void> = new Set();

  constructor(initialConfig?: Partial<StreamingConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...initialConfig };
    this.validateConfig();
  }

  /**
   * Get current configuration
   */
  getConfig(): Readonly<StreamingConfig> {
    return { ...this.config };
  }

  /**
   * Update configuration partially
   */
  updateConfig(updates: Partial<StreamingConfig>): void {
    this.config = { ...this.config, ...updates };
    this.validateConfig();
    this.notifyListeners();
  }

  /**
   * Get specific config value
   */
  get<K extends keyof StreamingConfig>(key: K): StreamingConfig[K] {
    return this.config[key];
  }

  /**
   * Set specific config value
   */
  set<K extends keyof StreamingConfig>(key: K, value: StreamingConfig[K]): void {
    this.config[key] = value;
    this.validateConfig();
    this.notifyListeners();
  }

  /**
   * Subscribe to config changes
   */
  subscribe(listener: (config: StreamingConfig) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Reset to default configuration
   */
  reset(): void {
    this.config = { ...DEFAULT_CONFIG };
    this.notifyListeners();
  }

  /**
   * Validate configuration values
   */
  private validateConfig(): void {
    const c = this.config;

    // Peer validation
    if (c.maxActivePeers < c.minActivePeers) {
      throw new Error('maxActivePeers must be >= minActivePeers');
    }
    if (c.minActivePeers < 0) {
      throw new Error('minActivePeers must be >= 0');
    }
    if (c.peerScoreThreshold < 0 || c.peerScoreThreshold > 1) {
      throw new Error('peerScoreThreshold must be between 0 and 1');
    }

    // Buffer validation
    if (c.bufferMinThreshold >= c.bufferMaxThreshold) {
      throw new Error('bufferMinThreshold must be < bufferMaxThreshold');
    }
    if (c.prefetchWindowAhead <= 0 || c.prefetchWindowBehind < 0) {
      throw new Error('prefetchWindow values must be positive');
    }

    // ABR validation
    if (c.abrSwitchUpThreshold <= c.abrSwitchDownThreshold) {
      throw new Error('abrSwitchUpThreshold must be > abrSwitchDownThreshold');
    }
    if (c.bandwidthEstimationWindow < 1) {
      throw new Error('bandwidthEstimationWindow must be >= 1');
    }

    // Cache validation
    if (c.cacheSizeLimit <= 0) {
      throw new Error('cacheSizeLimit must be > 0');
    }

    // Fetch validation
    if (c.maxConcurrentFetches < 1) {
      throw new Error('maxConcurrentFetches must be >= 1');
    }
    if (c.maxRetries < 0) {
      throw new Error('maxRetries must be >= 0');
    }
  }

  /**
   * Notify all listeners of config changes
   */
  private notifyListeners(): void {
    const config = this.getConfig();
    this.listeners.forEach(listener => listener(config));
  }

  /**
   * Export configuration as JSON
   */
  toJSON(): string {
    return JSON.stringify(this.config, null, 2);
  }

  /**
   * Import configuration from JSON
   */
  fromJSON(json: string): void {
    try {
      const parsed = JSON.parse(json);
      this.config = { ...DEFAULT_CONFIG, ...parsed };
      this.validateConfig();
      this.notifyListeners();
    } catch (error) {
      throw new Error(`Failed to parse config JSON: ${error}`);
    }
  }

  /**
   * Get configuration optimized for specific network conditions
   */
  static getPreset(preset: 'high-bandwidth' | 'low-bandwidth' | 'balanced'): Partial<StreamingConfig> {
    switch (preset) {
      case 'high-bandwidth':
        return {
          maxActivePeers: 8,
          prefetchWindowAhead: 45,
          bufferTargetDuration: 30,
          maxConcurrentFetches: 6,
          abrSwitchUpThreshold: 0.7,
          seekPrefetchAhead: 8,
          seekPrefetchBehind: 3,
        };
      
      case 'low-bandwidth':
        return {
          maxActivePeers: 4,
          prefetchWindowAhead: 15,
          bufferTargetDuration: 10,
          maxConcurrentFetches: 2,
          abrSwitchDownThreshold: 0.5,
          cacheSizeLimit: 200 * 1024 * 1024, // 200MB
          seekPrefetchAhead: 3,
          seekPrefetchBehind: 1,
        };
      
      case 'balanced':
      default:
        return DEFAULT_CONFIG;
    }
  }

  // ============ Runtime Tuning Methods ============

  /**
   * Tune ABR settings for experimentation
   */
  tuneAbr(settings: {
    enabled?: boolean;
    switchUpThreshold?: number;
    switchDownThreshold?: number;
    bandwidthWindow?: number;
  }): void {
    const updates: Partial<StreamingConfig> = {};
    
    if (settings.enabled !== undefined) {
      updates.abrEnabled = settings.enabled;
    }
    if (settings.switchUpThreshold !== undefined) {
      updates.abrSwitchUpThreshold = settings.switchUpThreshold;
    }
    if (settings.switchDownThreshold !== undefined) {
      updates.abrSwitchDownThreshold = settings.switchDownThreshold;
    }
    if (settings.bandwidthWindow !== undefined) {
      updates.bandwidthEstimationWindow = settings.bandwidthWindow;
    }

    this.updateConfig(updates);
  }

  /**
   * Tune buffer settings for experimentation
   */
  tuneBuffer(settings: {
    targetDuration?: number;
    minThreshold?: number;
    maxThreshold?: number;
    minPrefetch?: number;
    prefetchAhead?: number;
    prefetchBehind?: number;
  }): void {
    const updates: Partial<StreamingConfig> = {};
    
    if (settings.targetDuration !== undefined) {
      updates.bufferTargetDuration = settings.targetDuration;
    }
    if (settings.minThreshold !== undefined) {
      updates.bufferMinThreshold = settings.minThreshold;
    }
    if (settings.maxThreshold !== undefined) {
      updates.bufferMaxThreshold = settings.maxThreshold;
    }
    if (settings.minPrefetch !== undefined) {
      updates.minBufferPrefetch = settings.minPrefetch;
    }
    if (settings.prefetchAhead !== undefined) {
      updates.prefetchWindowAhead = settings.prefetchAhead;
    }
    if (settings.prefetchBehind !== undefined) {
      updates.prefetchWindowBehind = settings.prefetchBehind;
    }

    this.updateConfig(updates);
  }

  /**
   * Tune P2P settings for experimentation
   */
  tunePeerToPeer(settings: {
    maxActivePeers?: number;
    minActivePeers?: number;
    connectionTimeout?: number;
    scoreThreshold?: number;
    maxConcurrentFetches?: number;
    staggeredDelay?: number;
    requestWaitMin?: number;
    requestWaitMax?: number;
  }): void {
    const updates: Partial<StreamingConfig> = {};
    
    if (settings.maxActivePeers !== undefined) {
      updates.maxActivePeers = settings.maxActivePeers;
    }
    if (settings.minActivePeers !== undefined) {
      updates.minActivePeers = settings.minActivePeers;
    }
    if (settings.connectionTimeout !== undefined) {
      updates.peerConnectionTimeout = settings.connectionTimeout;
    }
    if (settings.scoreThreshold !== undefined) {
      updates.peerScoreThreshold = settings.scoreThreshold;
    }
    if (settings.maxConcurrentFetches !== undefined) {
      updates.maxConcurrentFetches = settings.maxConcurrentFetches;
    }
    if (settings.staggeredDelay !== undefined) {
      updates.staggeredRequestDelay = settings.staggeredDelay;
    }
    if (settings.requestWaitMin !== undefined) {
      updates.segmentRequestWaitMin = settings.requestWaitMin;
    }
    if (settings.requestWaitMax !== undefined) {
      updates.segmentRequestWaitMax = settings.requestWaitMax;
    }

    this.updateConfig(updates);
  }

  /**
   * Tune seek prefetch window for optimal playback after seek
   */
  tuneSeekPrefetch(settings: {
    segmentsAhead?: number;
    segmentsBehind?: number;
    prefetchWindowAhead?: number;
    prefetchWindowBehind?: number;
  }): void {
    const updates: Partial<StreamingConfig> = {};
    
    if (settings.segmentsAhead !== undefined) {
      updates.seekPrefetchAhead = settings.segmentsAhead;
    }
    if (settings.segmentsBehind !== undefined) {
      updates.seekPrefetchBehind = settings.segmentsBehind;
    }
    if (settings.prefetchWindowAhead !== undefined) {
      updates.prefetchWindowAhead = settings.prefetchWindowAhead;
    }
    if (settings.prefetchWindowBehind !== undefined) {
      updates.prefetchWindowBehind = settings.prefetchWindowBehind;
    }

    this.updateConfig(updates);
  }

  /**
   * Get seeder URL for a specific resource
   */
  getSeederUrl(movieId: string, qualityId: string, resource: 'master' | 'playlist' | 'init' | string): string {
    const base = this.config.baseUrl + '/streams';
    
    switch (resource) {
      case 'master':
        return `${base}/movies/${movieId}/master.m3u8`;
      
      case 'playlist':
        return `${base}/movies/${movieId}/${qualityId}/playlist.m3u8`;
      
      case 'init':
        return `${base}/movies/${movieId}/${qualityId}/init.mp4`;
      
      default:
        // Assume resource is a segment ID with extension (e.g., "seg_0001.m4s")
        return `${base}/movies/${movieId}/${qualityId}/${resource}`;
    }
  }

  /**
   * Apply quick performance profile
   */
  applyPerformanceProfile(profile: 'aggressive' | 'conservative' | 'balanced'): void {
    switch (profile) {
      case 'aggressive':
        // Maximum performance - more peers, larger buffer, aggressive ABR
        this.updateConfig({
          maxActivePeers: 10,
          prefetchWindowAhead: 60,
          bufferTargetDuration: 30,
          bufferMaxThreshold: 90,
          maxConcurrentFetches: 8,
          abrSwitchUpThreshold: 0.6,
          abrSwitchDownThreshold: 0.4,
          seekPrefetchAhead: 10,
          seekPrefetchBehind: 3,
        });
        break;

      case 'conservative':
        // Battery/bandwidth saving - fewer peers, smaller buffer
        this.updateConfig({
          maxActivePeers: 3,
          prefetchWindowAhead: 15,
          bufferTargetDuration: 10,
          bufferMaxThreshold: 30,
          maxConcurrentFetches: 2,
          abrSwitchUpThreshold: 0.85,
          abrSwitchDownThreshold: 0.25,
          seekPrefetchAhead: 3,
          seekPrefetchBehind: 1,
          cacheSizeLimit: 200 * 1024 * 1024, // 200MB
        });
        break;

      case 'balanced':
      default:
        // Reset to balanced defaults
        this.config = { ...DEFAULT_CONFIG };
        this.notifyListeners();
        break;
    }
  }

  /**
   * Get runtime statistics about current config
   */
  getStats(): {
    peerSettings: { max: number; min: number; timeout: number };
    bufferSettings: { target: number; min: number; max: number };
    abrSettings: { enabled: boolean; upThreshold: number; downThreshold: number };
    cacheSettings: { sizeLimit: number; segmentTTL: number };
    endpoints: { baseUrl: string };
  } {
    return {
      peerSettings: {
        max: this.config.maxActivePeers,
        min: this.config.minActivePeers,
        timeout: this.config.peerConnectionTimeout,
      },
      bufferSettings: {
        target: this.config.bufferTargetDuration,
        min: this.config.bufferMinThreshold,
        max: this.config.bufferMaxThreshold,
      },
      abrSettings: {
        enabled: this.config.abrEnabled,
        upThreshold: this.config.abrSwitchUpThreshold,
        downThreshold: this.config.abrSwitchDownThreshold,
      },
      cacheSettings: {
        sizeLimit: this.config.cacheSizeLimit,
        segmentTTL: this.config.cacheSegmentTTL,
      },
      endpoints: {
        baseUrl: this.config.baseUrl,
      },
    };
  }
}

/**
 * Global config instance (singleton pattern)
 */
let globalConfig: ConfigManager | null = null;

export function getGlobalConfig(): ConfigManager {
  if (!globalConfig) {
    globalConfig = new ConfigManager();
  }
  return globalConfig;
}

export function setGlobalConfig(config: ConfigManager): void {
  globalConfig = config;
}
