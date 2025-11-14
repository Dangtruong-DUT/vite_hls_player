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
  id: string;          // Format: "seg_0001.m4s"
  qualityId: string;
  duration: number;
  url: string;
  byteRange?: { start: number; end: number };
  timestamp: number; // Start time in seconds
}

export interface SegmentMetadata {
  id: string;          // Format: "seg_0001.m4s"
  movieId: string;
  qualityId: string;
  duration: number;
  size?: number;
  timestamp: number;
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

// Client -> Server message types
export type ClientMessageType = 
  | 'whoHas'          // Tìm peer có segment
  | 'reportSegment'   // Báo cáo đã tải segment
  | 'rtcOffer'        // WebRTC offer
  | 'rtcAnswer'       // WebRTC answer
  | 'iceCandidate';   // ICE candidate

// Server -> Client message types
export type ServerMessageType = 
  | 'peerList'        // Danh sách peer khi connect
  | 'whoHasReply'     // Kết quả tìm peer
  | 'reportAck'       // Xác nhận báo cáo
  | 'rtcOffer'        // Forward WebRTC offer
  | 'rtcAnswer'       // Forward WebRTC answer
  | 'iceCandidate'    // Forward ICE candidate
  | 'error';          // Thông báo lỗi

// Base signaling message
export interface SignalingMessage {
  type: ClientMessageType | ServerMessageType;
  [key: string]: unknown; // Allow other fields
}

// ===== CLIENT -> SERVER MESSAGES =====

// 1. whoHas - Tìm peer có segment
export interface WhoHasRequest extends SignalingMessage {
  type: 'whoHas';
  movieId: string;
  qualityId: string;
  segmentId: string;  // Format: "seg_0001.m4s" (bao gồm cả extension)
}

// 2. reportSegment - Báo cáo đã tải segment
export interface ReportSegmentRequest extends SignalingMessage {
  type: 'reportSegment';
  movieId?: string;      // Optional, lấy từ session nếu không có
  qualityId: string;
  segmentId: string;     // Format: "seg_0001.m4s" (bao gồm cả extension)
  source?: 'peer' | 'server';  // Default: "peer"
  latency?: number;      // milliseconds, default: 0
  speed?: number;        // Mbps, default: 0
}

// 3. rtcOffer - WebRTC offer
export interface RtcOfferRequest extends SignalingMessage {
  type: 'rtcOffer';
  from?: string;         // Auto-set by server
  to: string;            // Target peer clientId
  streamId: string;      // Movie ID
  sdp: string;           // WebRTC SDP
}

// 4. rtcAnswer - WebRTC answer
export interface RtcAnswerRequest extends SignalingMessage {
  type: 'rtcAnswer';
  from?: string;         // Auto-set by server
  to: string;            // Target peer clientId
  streamId: string;      // Movie ID
  sdp: string;           // WebRTC SDP
}

// 5. iceCandidate - ICE candidate
export interface IceCandidateRequest extends SignalingMessage {
  type: 'iceCandidate';
  from?: string;         // Auto-set by server
  to: string;            // Target peer clientId
  streamId: string;      // Movie ID
  candidate: RTCIceCandidateInit;  // ICE candidate object
}

// ===== SERVER -> CLIENT MESSAGES =====

// 1. peerList - Danh sách peer khi connect
export interface PeerListMessage extends SignalingMessage {
  type: 'peerList';
  streamId: string;
  peers: string[];       // Array of clientIds (không bao gồm chính client)
}

// 2. whoHasReply - Kết quả tìm peer
export interface SignalingPeerMetrics {
  uploadSpeed: number;   // Mbps
  latency: number;       // milliseconds
  successRate: number;   // 0.0 - 1.0
  lastActive: number;    // Unix epoch milliseconds
}

export interface SignalingPeerInfo {
  peerId: string;
  metrics: SignalingPeerMetrics;
}

export interface WhoHasReplyMessage extends SignalingMessage {
  type: 'whoHasReply';
  segmentId: string;     // Format: "seg_0001.m4s" (bao gồm cả extension)
  peers: SignalingPeerInfo[];     // Array of peers with metrics (có thể rỗng)
}

// 3. reportAck - Xác nhận báo cáo
export interface ReportAckMessage extends SignalingMessage {
  type: 'reportAck';
  segmentId: string;     // Format: "seg_0001.m4s" (bao gồm cả extension)
}

// 4. rtcOffer forwarded from another peer
export interface RtcOfferMessage extends SignalingMessage {
  type: 'rtcOffer';
  from: string;          // Sender peer clientId
  to: string;            // Target peer clientId
  streamId: string;
  sdp: string;
}

// 5. rtcAnswer forwarded from another peer
export interface RtcAnswerMessage extends SignalingMessage {
  type: 'rtcAnswer';
  from: string;          // Sender peer clientId
  to: string;            // Target peer clientId
  streamId: string;
  sdp: string;
}

// 6. iceCandidate forwarded from another peer
export interface IceCandidateMessage extends SignalingMessage {
  type: 'iceCandidate';
  from: string;          // Sender peer clientId
  to: string;            // Target peer clientId
  streamId: string;
  candidate: RTCIceCandidateInit;
}

// 7. error - Thông báo lỗi
export interface ErrorMessage extends SignalingMessage {
  type: 'error';
  message: string;
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

export type SegmentKey = `${string}:${string}`; // qualityId:segmentId (e.g., "720p:seg_0001.m4s")

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

// ============ Helper Functions ============

/**
 * Format segment numeric index to standard segment ID string
 * @param index - Segment index (0-based or 1-based)
 * @returns Formatted segment ID string (e.g., "seg_0001.m4s")
 */
export function formatSegmentId(index: number): string {
  return `seg_${String(index).padStart(4, '0')}.m4s`;
}

/**
 * Parse segment ID to extract numeric index
 * @param segmentId - Segment ID (e.g., "seg_0001.m4s" or "42.m4s")
 * @returns Numeric index
 */
export function parseSegmentIndex(segmentId: string): number {
  const newFormatMatch = segmentId.match(/seg_(\d+)\.m4s/);
  const oldFormatMatch = segmentId.match(/(\d+)\.m4s/);
  
  if (newFormatMatch) {
    return parseInt(newFormatMatch[1], 10);
  } else if (oldFormatMatch) {
    return parseInt(oldFormatMatch[1], 10);
  }
  
  return 0;
}

/**
 * Compare two segment IDs for ordering
 * Can compare strings directly since format is zero-padded
 * @param a - First segment ID
 * @param b - Second segment ID  
 * @returns Negative if a < b, positive if a > b, 0 if equal
 */
export function compareSegmentIds(a: string, b: string): number {
  return a.localeCompare(b);
}
