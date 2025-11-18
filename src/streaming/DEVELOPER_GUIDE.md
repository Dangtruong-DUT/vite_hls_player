# Streaming Player - Developer Guide

## Giới thiệu

Streaming Player đã được refactor hoàn toàn theo nguyên lý SOLID và design patterns OOP. Document này hướng dẫn cách sử dụng các components mới.

## Quick Start

### Cách sử dụng cơ bản (Backward Compatible)

```typescript
import { StreamingPlayerCoordinator } from '@/streaming';

const coordinator = new StreamingPlayerCoordinator({
  movieId: 'movie123',
  clientId: 'user-456',
  videoElement: document.querySelector('video'),
  signalingUrl: 'ws://localhost:8080/ws/signaling',
});

await coordinator.initialize();
await coordinator.play();
```

### Cách sử dụng nâng cao với Strategies

```typescript
import {
  StreamingPlayerCoordinator,
  LRUEvictionStrategy,
  AdaptiveBandwidthStrategy,
  HybridQualityStrategy,
} from '@/streaming';

// Tùy chỉnh cache strategy
const cacheManager = new CacheManager({
  maxSize: 1024 * 1024 * 1024, // 1GB
  evictionStrategy: new LRUEvictionStrategy(),
});

// Tùy chỉnh ABR strategies
const abrManager = new AbrManager(/* ... */);
abrManager.setBandwidthStrategy(new AdaptiveBandwidthStrategy());
abrManager.setQualityStrategy(new HybridQualityStrategy());
```

## Strategies

### Cache Eviction Strategies

#### LRU (Least Recently Used)
```typescript
const strategy = new LRUEvictionStrategy();
cacheManager.setEvictionStrategy(strategy);
```

**Khi nào dùng:**
- Phổ biến nhất, phù hợp hầu hết trường hợp
- Tốt khi có pattern truy cập tuần tự
- Hiệu quả với video playback bình thường

#### LFU (Least Frequently Used)
```typescript
const strategy = new LFUEvictionStrategy();
cacheManager.setEvictionStrategy(strategy);
```

**Khi nào dùng:**
- Khi có một số segments được xem nhiều lần (replay)
- Educational videos, tutorials
- Content có pattern xem lại cao

#### TTL (Time To Live)
```typescript
const strategy = new TTLEvictionStrategy();
cacheManager.setEvictionStrategy(strategy);
```

**Khi nào dùng:**
- Live streaming
- Content có tính thời điểm cao
- Cần đảm bảo freshness của data

#### Size-based
```typescript
const strategy = new SizeEvictionStrategy();
cacheManager.setEvictionStrategy(strategy);
```

**Khi nào dùng:**
- Cache size bị giới hạn chặt
- Cần free up space nhanh chóng
- Segments có size rất khác nhau

### Bandwidth Estimation Strategies

#### Moving Average
```typescript
const strategy = new MovingAverageBandwidthStrategy(5); // 5 samples
abrManager.setBandwidthStrategy(strategy);
```

**Đặc điểm:**
- Smooth, ổn định
- Phản ứng chậm với thay đổi đột ngột
- Tốt cho network ổn định

#### EWMA (Exponential Weighted Moving Average)
```typescript
const strategy = new EWMABandwidthStrategy(0.3); // alpha = 0.3
abrManager.setBandwidthStrategy(strategy);
```

**Đặc điểm:**
- Cân bằng giữa history và recent data
- Phản ứng nhanh hơn Moving Average
- Tốt cho network có biến động vừa phải

#### Harmonic Mean
```typescript
const strategy = new HarmonicMeanBandwidthStrategy(5);
abrManager.setBandwidthStrategy(strategy);
```

**Đặc điểm:**
- Penalize outliers
- Tốt khi có spikes ngẫu nhiên
- Conservative hơn arithmetic mean

#### Percentile
```typescript
const strategy = new PercentileBandwidthStrategy(10, 50); // p50
abrManager.setBandwidthStrategy(strategy);
```

**Đặc điểm:**
- Robust với outliers
- Có thể configure percentile (p25, p50, p75, p90)
- Tốt cho network có nhiễu

#### Adaptive
```typescript
const strategy = new AdaptiveBandwidthStrategy();
abrManager.setBandwidthStrategy(strategy);
```

**Đặc điểm:**
- Tự động switch giữa strategies
- Tốt nhất cho production
- Adapt theo network conditions

**Khuyến nghị:** Dùng `AdaptiveBandwidthStrategy` cho hầu hết trường hợp.

### Quality Selection Strategies

#### Conservative
```typescript
const strategy = new ConservativeQualityStrategy();
abrManager.setQualityStrategy(strategy);
```

**Đặc điểm:**
- Safety first
- Require 1.5x bandwidth
- Ít buffering nhất
- Chất lượng thấp hơn một chút

**Khi nào dùng:**
- Mobile networks
- Users với connection kém
- Ưu tiên smooth playback > quality

#### Aggressive
```typescript
const strategy = new AggressiveQualityStrategy();
abrManager.setQualityStrategy(strategy);
```

**Đặc điểm:**
- Quality first
- Require 1.2x bandwidth
- Có thể có buffering
- Chất lượng cao hơn

**Khi nào dùng:**
- WiFi, fiber connections
- Users quan tâm quality
- Screen size lớn (TV, desktop)

#### Buffer-based
```typescript
const strategy = new BufferBasedQualityStrategy();
abrManager.setQualityStrategy(strategy);
```

**Đặc điểm:**
- Dựa chủ yếu vào buffer level
- Switch quality frequently
- Adaptive với buffer status

**Khi nào dùng:**
- Variable network conditions
- Cần balance giữa quality và smoothness

#### Hybrid
```typescript
const strategy = new HybridQualityStrategy();
abrManager.setQualityStrategy(strategy);
```

**Đặc điểm:**
- Cân bằng bandwidth và buffer
- 60% bandwidth weight, 40% buffer weight
- Balanced approach

**Khi nào dùng:**
- Production default
- Most use cases
- Good balance

#### BOLA (Advanced)
```typescript
const strategy = new BOLAQualityStrategy();
abrManager.setQualityStrategy(strategy);
```

**Đặc điểm:**
- Research-backed algorithm
- Mathematically optimal
- Buffer occupancy based

**Khi nào dùng:**
- Advanced users
- Research projects
- Optimal QoE

**Khuyến nghị:** 
- Default: `HybridQualityStrategy`
- Poor network: `ConservativeQualityStrategy`
- Good network: `AggressiveQualityStrategy`
- Research: `BOLAQualityStrategy`

## Configuration

### Preset Configurations

```typescript
import { ConfigManager } from '@/streaming';

// High bandwidth preset (WiFi, Fiber)
const config = ConfigManager.getPreset('high-bandwidth');

// Low bandwidth preset (Mobile)
const config = ConfigManager.getPreset('low-bandwidth');

// Balanced preset (Default)
const config = ConfigManager.getPreset('balanced');
```

### Custom Configuration

```typescript
const configManager = new ConfigManager({
  // Peer settings
  maxActivePeers: 6,
  minActivePeers: 2,
  
  // Buffer settings
  prefetchWindowAhead: 60,
  bufferTargetDuration: 30,
  
  // ABR settings
  abrEnabled: true,
  
  // Cache settings
  cacheSizeLimit: 1024 * 1024 * 1024, // 1GB
});
```

## Testing

### Unit Testing với Mocks

```typescript
import { IConfigManager, ICacheManager } from '@/streaming/interfaces';

class MockConfigManager implements IConfigManager {
  private config = DEFAULT_CONFIG;
  
  getConfig() { return this.config; }
  get(key) { return this.config[key]; }
  // ... implement other methods
}

describe('BufferManager', () => {
  it('should initialize correctly', () => {
    const mockConfig = new MockConfigManager();
    const buffer = new BufferManager(video, mse, mockConfig);
    // Test
  });
});
```

### Integration Testing

```typescript
describe('Streaming Player Integration', () => {
  it('should play video smoothly', async () => {
    const coordinator = new StreamingPlayerCoordinator({
      movieId: 'test-movie',
      clientId: 'test-client',
      videoElement: createMockVideoElement(),
    });
    
    await coordinator.initialize();
    await coordinator.play();
    
    // Assert playback state
  });
});
```

## Event Handling

### Subscribe to Events

```typescript
// Buffer events
bufferManager.on('bufferLow', (bufferAhead) => {
  console.log(`Buffer low: ${bufferAhead}s`);
});

bufferManager.on('bufferCritical', (bufferAhead) => {
  console.log(`Buffer critical: ${bufferAhead}s`);
});

// Quality events
abrManager.on('qualityChanged', (oldQuality, newQuality, reason) => {
  console.log(`Quality: ${oldQuality?.id} → ${newQuality.id} (${reason})`);
});

// Peer events
peerManager.on('peerConnected', (peerId) => {
  console.log(`Peer connected: ${peerId}`);
});
```

### Unsubscribe

```typescript
const handler = (bufferAhead) => console.log(bufferAhead);
bufferManager.on('bufferLow', handler);

// Later
bufferManager.off('bufferLow', handler);
```

## Performance Optimization

### Cache Tuning

```typescript
// High-memory devices
const cache = new CacheManager({
  maxSize: 2048 * 1024 * 1024, // 2GB
  evictionStrategy: new LRUEvictionStrategy(),
});

// Low-memory devices
const cache = new CacheManager({
  maxSize: 256 * 1024 * 1024, // 256MB
  evictionStrategy: new SizeEvictionStrategy(),
});
```

### Buffer Tuning

```typescript
// Smooth playback priority
const config = {
  bufferTargetDuration: 40,
  bufferMinThreshold: 10,
  prefetchWindowAhead: 60,
};

// Quick start priority
const config = {
  bufferTargetDuration: 20,
  bufferMinThreshold: 5,
  prefetchWindowAhead: 30,
};
```

### P2P Tuning

```typescript
// Many peers available
const config = {
  maxActivePeers: 10,
  peerConnectionTimeout: 3000,
};

// Few peers
const config = {
  maxActivePeers: 3,
  peerConnectionTimeout: 5000,
};
```

## Debugging

### Enable Logging

```typescript
// Set log level (trong development)
localStorage.setItem('streaming:logLevel', 'debug');

// View specific manager logs
localStorage.setItem('streaming:logModules', 'BufferManager,AbrManager');
```

### Monitor Performance

```typescript
// Get fetch statistics
const stats = integratedFetchClient.getStats();
console.log('P2P ratio:', stats.p2pFetches / stats.totalFetches);
console.log('Avg P2P latency:', stats.avgP2pLatency);

// Get cache statistics
const cacheStats = cacheManager.getStats();
console.log('Cache hit rate:', cacheStats.hitRate);
console.log('Cache usage:', cacheStats.currentSize / cacheStats.maxSize);
```

## Migration Guide

### From Old API to New API

```typescript
// Old (still works)
const coordinator = new StreamingPlayerCoordinator(options);

// New (recommended)
const configManager = new ConfigManager(configOverrides);
const cacheManager = new CacheManager({
  evictionStrategy: new LRUEvictionStrategy(),
});

// Inject dependencies
const coordinator = new StreamingPlayerCoordinator({
  ...options,
  configManager,
  cacheManager,
});
```

## Best Practices

1. **Always use interfaces for dependencies**
   ```typescript
   class MyComponent {
     constructor(private config: IConfigManager) {} // ✅
     // Not: constructor(private config: ConfigManager) {} // ❌
   }
   ```

2. **Configure strategies at startup**
   ```typescript
   // ✅ Good
   const manager = new AbrManager();
   manager.setBandwidthStrategy(new AdaptiveBandwidthStrategy());
   
   // ❌ Bad - switching strategies during playback
   ```

3. **Clean up resources**
   ```typescript
   // When done
   coordinator.destroy();
   peerManager.destroy();
   bufferManager.destroy();
   ```

4. **Handle errors gracefully**
   ```typescript
   coordinator.on('error', (error) => {
     console.error('Playback error:', error);
     // Show user-friendly message
     // Fallback to HTTP
   });
   ```

## Troubleshooting

### Problem: Buffering too much
**Solution:**
```typescript
const config = {
  bufferMinThreshold: 8, // Increase
  prefetchWindowAhead: 40, // Decrease
};
```

### Problem: Quality switching too often
**Solution:**
```typescript
abrManager.setQualityStrategy(new ConservativeQualityStrategy());
```

### Problem: High memory usage
**Solution:**
```typescript
const cache = new CacheManager({
  maxSize: 512 * 1024 * 1024, // Reduce
  evictionStrategy: new SizeEvictionStrategy(), // Use size-based
});
```

### Problem: P2P not working
**Solution:**
1. Check signaling connection
2. Check STUN/TURN servers
3. Check firewall/NAT
4. Enable debug logging

## Advanced Topics

### Custom Strategy Implementation

```typescript
import { IBandwidthEstimationStrategy } from '@/streaming/interfaces';

class MyCustomBandwidthStrategy implements IBandwidthEstimationStrategy {
  readonly name = 'MyCustom';
  
  addSample(bytes: number, latency: number): void {
    // Your logic
  }
  
  getEstimate(): number {
    // Your logic
    return 0;
  }
  
  reset(): void {
    // Your logic
  }
}

// Use it
abrManager.setBandwidthStrategy(new MyCustomBandwidthStrategy());
```

### Plugin Architecture (Future)

```typescript
// Future feature
const plugin = new MyCustomPlugin();
coordinator.registerPlugin(plugin);
```

## Resources

- [SOLID Principles](https://en.wikipedia.org/wiki/SOLID)
- [Design Patterns](https://refactoring.guru/design-patterns)
- [MSE API](https://developer.mozilla.org/en-US/docs/Web/API/Media_Source_Extensions_API)
- [WebRTC](https://webrtc.org/)

## Support

For issues and questions:
- GitHub Issues: [link]
- Documentation: [link]
- Examples: `examples/` directory
