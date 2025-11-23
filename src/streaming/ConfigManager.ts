import type { StreamingConfig } from './types';
import type { IConfigManager } from './interfaces/IConfigManager';
import { ConfigValidator } from './utils/ConfigValidator';

/**
 * Application Constants - All magic strings and numbers centralized here
 */
export const APP_CONSTANTS = {
  // File extensions and formats
  FILE_EXTENSIONS: {
    MASTER_PLAYLIST: '.m3u8',
    VARIANT_PLAYLIST: '.m3u8',
    INIT_SEGMENT: '.mp4',
    MEDIA_SEGMENT: '.m4s',
  },
  
  // Segment naming patterns
  SEGMENT_PATTERNS: {
    PREFIX: 'seg_',
    REGEX: /seg_(\d+)\.m4s/,
    PADDING_LENGTH: 4,
    PADDING_CHAR: '0',
  },
  
  // API paths
  API_PATHS: {
    STREAMS_BASE: '/streams/movies',
    MASTER_PLAYLIST: 'master.m3u8',
    VARIANT_PLAYLIST: 'playlist.m3u8',
    INIT_SEGMENT: 'init.mp4',
  },
  
  // Timing constants (in milliseconds)
  TIMING: {
    MONITORING_INTERVAL: 1000,
    CLEANUP_INTERVAL: 10000,
    CRITICAL_FETCH_DEBOUNCE: 1000,
    CACHE_CLEANUP_INTERVAL: 5 * 60 * 1000, // 5 minutes
    SIGNALING_DEBOUNCE: 500,
    CONNECTION_TIMEOUT: 5000,
    WHOHAS_CACHE_TTL: 5000,
    RECONNECT_CLEANUP_DELAY: 100,
  },
  
  // Bandwidth calculation constants
  BANDWIDTH: {
    BITS_PER_BYTE: 8,
    MS_TO_SECONDS: 1000,
  },
  
  // WebRTC configuration
  WEBRTC: {
    ICE_SERVERS: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
    ],
    DATA_CHANNEL: {
      NAME: 'segments',
      ORDERED: true,
      MAX_RETRANSMITS: 3,
    },
  },
  
  // Cache configuration defaults
  CACHE_DEFAULTS: {
    MAX_SIZE: 500 * 1024 * 1024, // 500MB
    SEGMENT_TTL: 30 * 60 * 1000, // 30 minutes
    INIT_TTL: 24 * 60 * 60 * 1000, // 24 hours
    PLAYLIST_TTL: 60 * 60 * 1000, // 1 hour
    HOT_CACHE_PROTECTION: true,
  },
  
  // WebSocket configuration
  WEBSOCKET: {
    PROTOCOL: 'ws',
    PATH: '/ws/signaling',
    DEFAULT_PORT: 8080,
    DEFAULT_HOST: 'localhost',
    // URL template with placeholders: {protocol}, {host}, {port}, {path}, {clientId}, {movieId}
    URL_TEMPLATE: '{protocol}://{host}:{port}{path}?clientId={clientId}&movieId={movieId}',
  },
  
  // MIME types
  MIME_TYPES: {
    DEFAULT_VIDEO: 'video/mp4; codecs="avc1.64001f,mp4a.40.2"',
  },
} as const;

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
  fetchTimeout: 10000, // 10s - increased for better HTTP reliability
  maxRetries: 1, // Reduced to 1 - IntegratedFetchClient handles fallback strategy
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

/**
 * ConfigManager implementing IConfigManager interface
 * Applies Single Responsibility Principle by delegating validation to ConfigValidator
 */
export class ConfigManager implements IConfigManager {
  private config: StreamingConfig;
  private listeners: Set<(config: StreamingConfig) => void> = new Set();
  private validator: ConfigValidator;

  constructor(initialConfig?: Partial<StreamingConfig>) {
    this.validator = new ConfigValidator();
    this.config = { ...DEFAULT_CONFIG, ...initialConfig };
    this.validator.validate(this.config);
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
    this.validator.validate(this.config);
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
    this.validator.validate(this.config);
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
      this.validator.validate(this.config);
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
   * Build signaling server WebSocket URL from template
   * @param clientId - Client ID
   * @param movieId - Movie ID
   * @param customUrl - Optional custom URL template (overrides default)
   * @returns Formatted WebSocket URL
   */
  buildSignalingUrl(
    clientId: string,
    movieId: string,
    customUrl?: string
  ): string {
    const { PROTOCOL, DEFAULT_HOST, DEFAULT_PORT, PATH, URL_TEMPLATE } = APP_CONSTANTS.WEBSOCKET;
    // Use custom template from config if provided, otherwise use parameter or default
    const template = customUrl || this.config.signalingUrlTemplate || URL_TEMPLATE;
    
    return template
      .replace('{protocol}', PROTOCOL)
      .replace('{host}', DEFAULT_HOST)
      .replace('{port}', String(DEFAULT_PORT))
      .replace('{path}', PATH)
      .replace('{clientId}', clientId)
      .replace('{movieId}', movieId);
  }

  /**
   * Get seeder URL for a specific resource
   */
  getSeederUrl(movieId: string, qualityId: string, resource: 'master' | 'playlist' | 'init' | string): string {
    const base = this.config.baseUrl;
    const { STREAMS_BASE, MASTER_PLAYLIST, VARIANT_PLAYLIST, INIT_SEGMENT } = APP_CONSTANTS.API_PATHS;
    
    switch (resource) {
      case 'master':
        return `${base}${STREAMS_BASE}/${movieId}/${MASTER_PLAYLIST}`;
      
      case 'playlist':
        return `${base}${STREAMS_BASE}/${movieId}/${qualityId}/${VARIANT_PLAYLIST}`;
      
      case 'init':
        return `${base}${STREAMS_BASE}/${movieId}/${qualityId}/${INIT_SEGMENT}`;
      
      default:
        // Assume resource is a segment ID with extension (e.g., "seg_0001.m4s")
        return `${base}${STREAMS_BASE}/${movieId}/${qualityId}/${resource}`;
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
