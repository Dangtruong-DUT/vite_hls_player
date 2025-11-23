import type { StreamingConfig } from '../types';

export interface IConfigValidator {
  validate(config: StreamingConfig): void;
}

export interface IConfigManager {
  getConfig(): Readonly<StreamingConfig>;
  get<K extends keyof StreamingConfig>(key: K): StreamingConfig[K];
  updateConfig(updates: Partial<StreamingConfig>): void;
  set<K extends keyof StreamingConfig>(key: K, value: StreamingConfig[K]): void;
  reset(): void;
  subscribe(listener: (config: StreamingConfig) => void): () => void;
  toJSON(): string;
  fromJSON(json: string): void;
}
