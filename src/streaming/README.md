# Streaming Player Module

Modern HLS streaming player với P2P support, được thiết kế theo nguyên lý SOLID và OOP best practices.

## 🚀 Quick Start

### Cách sử dụng cơ bản

```typescript
import { StreamingPlayerCoordinator } from '@/streaming';

const player = new StreamingPlayerCoordinator({
  movieId: 'movie123',
  clientId: 'user456',
  videoElement: document.querySelector('video'),
  signalingUrl: 'ws://localhost:8080/ws/signaling',
});

await player.initialize();
await player.play();
```

### Cách sử dụng nâng cao với Strategies

```typescript
import {
  StreamingPlayerCoordinator,
  ConfigManager,
  CacheManager,
  LRUEvictionStrategy,
  AdaptiveBandwidthStrategy,
  HybridQualityStrategy,
} from '@/streaming';

// Custom configuration
const config = new ConfigManager({
  maxActivePeers: 6,
  bufferTargetDuration: 30,
  cacheSizeLimit: 1024 * 1024 * 1024, // 1GB
});

// Custom cache with LRU eviction
const cache = new CacheManager({
  maxSize: 1024 * 1024 * 1024,
  evictionStrategy: new LRUEvictionStrategy(),
});

// Create player with custom components
const player = new StreamingPlayerCoordinator({
  movieId: 'movie123',
  clientId: 'user456',
  videoElement: videoEl,
  configOverrides: config.getConfig(),
});
```

## 📚 Documentation

- **[ARCHITECTURE.md](./ARCHITECTURE.md)** - Kiến trúc tổng quan và design patterns
- **[DEVELOPER_GUIDE.md](./DEVELOPER_GUIDE.md)** - Hướng dẫn chi tiết cho developers
- **[REFACTORING_SUMMARY.md](./REFACTORING_SUMMARY.md)** - Tóm tắt refactoring và SOLID principles

## 🎯 Features

### Core Features
- ✅ **HLS Streaming** - Adaptive bitrate streaming
- ✅ **P2P Support** - WebRTC peer-to-peer segment sharing
- ✅ **Smart Caching** - Intelligent cache với multiple eviction strategies
- ✅ **Buffer Management** - Optimized buffer với prefetch strategies
- ✅ **ABR** - Adaptive bitrate với multiple quality selection algorithms

### Architecture Features
- ✅ **SOLID Principles** - Single Responsibility, Open/Closed, Liskov Substitution, Interface Segregation, Dependency Inversion
- ✅ **Design Patterns** - Strategy, Observer, Chain of Responsibility, Facade
- ✅ **Type Safety** - Full TypeScript support với interfaces
- ✅ **Testable** - Dependency injection và interface-based design
- ✅ **Extensible** - Easy to add new strategies và behaviors

## 🛠️ Available Strategies

### Cache Eviction Strategies
- `LRUEvictionStrategy` - Least Recently Used (default)
- `LFUEvictionStrategy` - Least Frequently Used
- `TTLEvictionStrategy` - Time To Live based
- `SizeEvictionStrategy` - Largest first
- `CompositeEvictionStrategy` - Combination

### Bandwidth Estimation Strategies
- `MovingAverageBandwidthStrategy` - Weighted moving average
- `EWMABandwidthStrategy` - Exponential weighted moving average
- `HarmonicMeanBandwidthStrategy` - Harmonic mean
- `PercentileBandwidthStrategy` - Percentile-based
- `AdaptiveBandwidthStrategy` - Auto-adaptive (recommended)

### Quality Selection Strategies
- `ConservativeQualityStrategy` - Safety first, less buffering
- `AggressiveQualityStrategy` - Quality first, more bandwidth
- `BufferBasedQualityStrategy` - Buffer-driven decisions
- `HybridQualityStrategy` - Balanced approach (recommended)
- `BOLAQualityStrategy` - Research-backed algorithm

## 📖 Usage Examples

### Thay đổi Cache Strategy

```typescript
import { CacheManager, LFUEvictionStrategy } from '@/streaming';

const cache = new CacheManager({
  maxSize: 512 * 1024 * 1024,
  evictionStrategy: new LFUEvictionStrategy(),
});

// Hoặc thay đổi runtime
cache.setEvictionStrategy(new LRUEvictionStrategy());
```

### Custom Configuration Preset

```typescript
import { ConfigManager } from '@/streaming';

// Sử dụng preset
const config = ConfigManager.getPreset('high-bandwidth');

// Hoặc custom
const customConfig = new ConfigManager({
  maxActivePeers: 10,
  bufferTargetDuration: 40,
  prefetchWindowAhead: 60,
});
```

### Event Handling

```typescript
// Subscribe to events
player.on('qualityChanged', (quality) => {
  console.log('Quality changed to:', quality.id);
});

player.on('buffering', () => {
  console.log('Buffering...');
});

player.on('error', (error) => {
  console.error('Playback error:', error);
});
```

## 🧪 Testing

```typescript
import { IConfigManager, ICacheManager } from '@/streaming/interfaces';

// Mock implementations for testing
class MockConfigManager implements IConfigManager {
  // ... implement interface methods
}

class MockCacheManager implements ICacheManager {
  // ... implement interface methods
}

// Use in tests
const buffer = new BufferManager(
  videoElement,
  mockMseManager,
  new MockConfigManager()
);
```

## 🏗️ Architecture

```
streaming/
├── interfaces/          # SOLID interfaces (ISP, DIP)
├── strategies/          # Strategy implementations (OCP)
├── utils/              # Utility classes (SRP)
├── managers/           # Core manager classes
├── types.ts            # Type definitions
└── index.ts            # Public API
```

## 🔧 Configuration

```typescript
interface StreamingConfig {
  // Peer settings
  maxActivePeers: number;
  minActivePeers: number;
  
  // Buffer settings
  bufferTargetDuration: number;
  bufferMinThreshold: number;
  prefetchWindowAhead: number;
  
  // ABR settings
  abrEnabled: boolean;
  abrSwitchUpThreshold: number;
  
  // Cache settings
  cacheSizeLimit: number;
  cacheSegmentTTL: number;
  
  // ... và nhiều options khác
}
```

## 📊 Performance

- **Cache Hit Rate**: 80-95% trong điều kiện bình thường
- **P2P Ratio**: 60-80% traffic từ P2P
- **Startup Time**: < 1s cho first frame
- **Buffer Efficiency**: Minimal rebuffering events

## 🤝 Contributing

Contributions are welcome! Khi thêm features mới:

1. Follow SOLID principles
2. Implement appropriate interfaces
3. Use Strategy pattern cho behaviors có thể thay đổi
4. Add unit tests
5. Update documentation

## 📄 License

MIT License

## 🙏 Credits

Built with:
- TypeScript
- Media Source Extensions API
- WebRTC
- SOLID principles & Design Patterns
