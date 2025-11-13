/**
 * Core type definitions for streaming video player
 */

// ============ Quality & Segment Types ============

export interface Quality {
  id: string;
  bandwidth: number;
  width: number;
  height: number;
  codecs: string;
  frameRate?: number;
}

export interface Segment {
  id: number;
  qualityId: string;
  duration: number;
  url: string;
  byteRange?: { start: number; end: number };
  timestamp: number; // Start time in seconds
}

export interface SegmentMetadata {
  id: number;
  qualityId: string;
  duration: number;
  size?: number;
  timestamp: number;
  url: string;
}

export interface InitSegment {
  qualityId: string;
  data: ArrayBuffer;
  url: string;
}

// ============ Playlist Types ============

export interface MasterPlaylist {
  qualities: Quality[];
  defaultQualityId?: string;
}

export interface VariantPlaylist {
  qualityId: string;
  segments: SegmentMetadata[];
  targetDuration: number;
  totalDuration: number;
}

// ============ Peer & P2P Types ============

export interface PeerInfo {
  peerId: string;
  connectionState: 'new' | 'connecting' | 'connected' | 'disconnected' | 'failed';
  dataChannel?: RTCDataChannel;
  peerConnection?: RTCPeerConnection;
  score: number;
  availableSegments: Set<string>; // Set of segmentKey: `${qualityId}:${segmentId}`
  lastActive: number;
  metrics: {
    successCount: number;
    failureCount: number;
    avgLatency: number;
    bytesReceived: number;
  };
}

export interface PeerScore {
  peerId: string;
  score: number;
  latency: number;
  successRate: number;
  availability: number;
}

// ============ Buffer Types ============

export interface BufferRange {
  start: number;
  end: number;
}

export interface BufferStatus {
  buffered: BufferRange[];
  currentTime: number;
  duration: number;
  bufferAhead: number; // Seconds buffered ahead
  bufferBehind: number; // Seconds buffered behind
}

// ============ Cache Types ============

export interface CacheEntry<T> {
  key: string;
  data: T;
  size: number;
  timestamp: number;
  ttl: number; // Time to live in ms
  accessCount: number;
  lastAccessed: number;
}

export interface CacheStats {
  hits: number;
  misses: number;
  evictions: number;
  currentSize: number;
  maxSize: number;
  itemCount: number;
}

// ============ Fetch Types ============

export const FetchSource = {
  PEER: 'peer',
  SEEDER: 'seeder',
  ORIGIN: 'origin',
  CACHE: 'cache',
} as const;

export type FetchSource = typeof FetchSource[keyof typeof FetchSource];

export interface FetchResult {
  success: boolean;
  data?: ArrayBuffer;
  source: FetchSource;
  peerId?: string;
  latency: number;
  error?: Error;
}

export interface FetchRequest {
  segmentId: number;
  qualityId: string;
  priority: number;
  timestamp: number;
  retryCount: number;
}

// ============ Signaling Types ============

export interface WhoHasRequest {
  movieId: string;
  qualityId: string;
  segmentId: number;
}

export interface WhoHasResponse {
  segmentKey: string;
  peers: string[]; // Array of peerIds
  requestId?: string; // For matching with request
}

export interface SegmentAvailabilityReport {
  clientId: string;
  movieId: string;
  segments: Array<{
    qualityId: string;
    segmentId: number;
  }>;
}

export interface SignalingMessage {
  type: 'whoHas' | 'whoHasResponse' | 'segmentReport' | 'segmentFetchReport' | 'peerOffer' | 'peerAnswer' | 'iceCandidate' | 'error';
  payload: unknown;
  timestamp: number;
}

// ============ Player State Types ============

export interface PlayerState {
  isPlaying: boolean;
  isPaused: boolean;
  isSeeking: boolean;
  isBuffering: boolean;
  currentTime: number;
  duration: number;
  currentQuality: Quality | null;
  availableQualities: Quality[];
  volume: number;
  muted: boolean;
}

export interface PlaybackMetrics {
  bufferHealth: number; // 0-1, percentage of buffer filled
  downloadSpeed: number; // bytes/sec
  bandwidthEstimate: number; // bits/sec
  droppedFrames: number;
  stallCount: number;
  totalStallTime: number;
  p2pRatio: number; // percentage from P2P vs HTTP
  activeConnections: number;
}

// ============ Configuration Types ============

export interface StreamingConfig {
  // Peer settings
  maxActivePeers: number;
  minActivePeers: number;
  peerConnectionTimeout: number; // ms - timeout for establishing peer connection
  peerScoreThreshold: number;

  // Buffer settings
  prefetchWindowAhead: number; // seconds - prefetch window ahead of playback position
  prefetchWindowBehind: number; // seconds - prefetch window behind during seek
  bufferTargetDuration: number; // seconds - target buffer size
  bufferMinThreshold: number; // seconds - critical buffer threshold (start buffering)
  bufferMaxThreshold: number; // seconds - max buffer (stop prefetching)
  minBufferPrefetch: number; // seconds - minimum buffer before starting prefetch

  // ABR settings
  abrEnabled: boolean;
  abrSwitchUpThreshold: number; // buffer percentage (0-1) for switching up
  abrSwitchDownThreshold: number; // buffer percentage (0-1) for switching down
  bandwidthEstimationWindow: number; // number of segments for bandwidth estimation

  // Cache settings
  cacheSizeLimit: number; // bytes
  cacheSegmentTTL: number; // ms
  cachePlaylistTTL: number; // ms
  cacheInitSegmentTTL: number; // ms

  // Fetch settings
  maxConcurrentFetches: number;
  fetchTimeout: number; // ms - fallback HTTP timeout
  maxRetries: number;
  retryDelayBase: number; // ms
  staggeredRequestDelay: number; // ms
  segmentRequestWaitMin: number; // ms - minimum wait time before sending segment request
  segmentRequestWaitMax: number; // ms - maximum wait time before sending segment request

  // Signaling settings
  signalingReconnectInterval: number; // ms
  signalingHeartbeatInterval: number; // ms
  whoHasTimeout: number; // ms - timeout for WhoHas query (whohas_query_timeout)

  // Seek optimization settings
  seekPrefetchAhead: number; // number of segments to prefetch ahead on seek
  seekPrefetchBehind: number; // number of segments to prefetch behind on seek
  
  // API endpoints
  baseUrl: string;
}

// ============ Event Types ============

export interface PlayerEvent {
  type: string;
  timestamp: number;
  data?: unknown;
}

export interface SegmentEvent extends PlayerEvent {
  type: 'segment:fetched' | 'segment:appended' | 'segment:error';
  segmentId: number;
  qualityId: string;
  source?: FetchSource;
}

export interface BufferEvent extends PlayerEvent {
  type: 'buffer:low' | 'buffer:high' | 'buffer:stall';
  bufferStatus: BufferStatus;
}

export interface QualityEvent extends PlayerEvent {
  type: 'quality:changed' | 'quality:switching';
  oldQuality?: Quality;
  newQuality: Quality;
  reason: 'manual' | 'abr' | 'fallback';
}

export interface PeerEvent extends PlayerEvent {
  type: 'peer:connected' | 'peer:disconnected' | 'peer:error';
  peerId: string;
  error?: Error;
}

// ============ Utility Types ============

export type SegmentKey = `${string}:${number}`; // qualityId:segmentId

export interface TimeRange {
  start: number;
  end: number;
}

export interface SegmentRequest {
  segment: SegmentMetadata;
  priority: number;
  onSuccess: (data: ArrayBuffer, source: FetchSource) => void;
  onError: (error: Error) => void;
}
