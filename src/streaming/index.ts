/**
 * Streaming Module
 * Barrel export for all streaming player components
 */

// Core Types
export * from './types';

// Configuration
export { ConfigManager, DEFAULT_CONFIG, getGlobalConfig, setGlobalConfig } from './ConfigManager';

// MSE Manager
export { MseManager } from './MseManager';
export type { MseManagerEvents } from './MseManager';

// Cache Manager
export { CacheManager } from './CacheManager';
export type { CacheableData } from './CacheManager';

// Segment Fetcher
export { SegmentFetcher } from './SegmentFetcher';
export type { FetchOptions } from './SegmentFetcher';

// Buffer Manager
export { BufferManager } from './BufferManager';
export type { BufferManagerEvents } from './BufferManager';

// Peer Manager
export { PeerManager } from './PeerManager';
export type { PeerManagerEvents } from './PeerManager';

// Signaling Client
export { SignalingClient } from './SignalingClient';
export type { SignalingClientEvents } from './SignalingClient';

// ABR Manager
export { AbrManager } from './AbrManager';
export type { AbrManagerEvents } from './AbrManager';

// Integrated Fetch Client
export { IntegratedSegmentFetchClient } from './IntegratedSegmentFetchClient';
export type { SegmentFetchRequest, SegmentFetchStats } from './IntegratedSegmentFetchClient';

// Main Coordinator
export { StreamingPlayerCoordinator } from './StreamingPlayerCoordinator';
export type { StreamingPlayerOptions, StreamingPlayerEvents } from './StreamingPlayerCoordinator';
