/**
 * Configuration Manager Interfaces
 * Applies Interface Segregation and Dependency Inversion Principles
 */

import type { StreamingConfig } from '../types';

/**
 * Configuration Reader Interface (ISP - Read-only operations)
 */
export interface IConfigReader {
  /**
   * Get full configuration snapshot
   */
  getConfig(): Readonly<StreamingConfig>;

  /**
   * Get specific config value
   */
  get<K extends keyof StreamingConfig>(key: K): StreamingConfig[K];
}

/**
 * Configuration Writer Interface (ISP - Write operations)
 */
export interface IConfigWriter {
  /**
   * Update configuration partially
   */
  updateConfig(updates: Partial<StreamingConfig>): void;

  /**
   * Set specific config value
   */
  set<K extends keyof StreamingConfig>(key: K, value: StreamingConfig[K]): void;

  /**
   * Reset to default configuration
   */
  reset(): void;
}

/**
 * Configuration Observer Interface (ISP - Subscription operations)
 */
export interface IConfigObserver {
  /**
   * Subscribe to config changes
   */
  subscribe(listener: (config: StreamingConfig) => void): () => void;
}

/**
 * Configuration Validator Interface (SRP - Validation logic)
 */
export interface IConfigValidator {
  /**
   * Validate configuration
   * @throws Error if configuration is invalid
   */
  validate(config: StreamingConfig): void;
}

/**
 * Configuration Serializer Interface (SRP - Serialization logic)
 */
export interface IConfigSerializer {
  /**
   * Export configuration as JSON
   */
  toJSON(): string;

  /**
   * Import configuration from JSON
   * @throws Error if JSON is invalid
   */
  fromJSON(json: string): void;
}

/**
 * Complete Configuration Manager Interface
 * Combines all config-related interfaces
 */
export interface IConfigManager
  extends IConfigReader,
    IConfigWriter,
    IConfigObserver,
    IConfigSerializer {}

/**
 * Configuration Preset Provider Interface
 */
export interface IConfigPresetProvider {
  /**
   * Get configuration preset for specific network conditions
   */
  getPreset(preset: 'high-bandwidth' | 'low-bandwidth' | 'balanced'): Partial<StreamingConfig>;
}
