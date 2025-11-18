/**
 * Event Emitter Interface
 * Base interface for all event-driven components
 */

export interface IEventEmitter<TEvents extends Record<string, (...args: any[]) => void>> {
  /**
   * Register an event listener
   */
  on<K extends keyof TEvents>(event: K, listener: TEvents[K]): void;

  /**
   * Unregister an event listener
   */
  off<K extends keyof TEvents>(event: K, listener: TEvents[K]): void;

  /**
   * Register a one-time event listener
   */
  once<K extends keyof TEvents>(event: K, listener: TEvents[K]): void;

  /**
   * Remove all listeners for a specific event or all events
   */
  removeAllListeners(event?: keyof TEvents): void;
}

/**
 * Base EventEmitter implementation
 */
export abstract class EventEmitter<TEvents extends Record<string, (...args: any[]) => void>>
  implements IEventEmitter<TEvents> {
  private listeners = new Map<keyof TEvents, Set<(...args: any[]) => void>>();

  on<K extends keyof TEvents>(event: K, listener: TEvents[K]): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(listener);
  }

  off<K extends keyof TEvents>(event: K, listener: TEvents[K]): void {
    const eventListeners = this.listeners.get(event);
    if (eventListeners) {
      eventListeners.delete(listener);
      if (eventListeners.size === 0) {
        this.listeners.delete(event);
      }
    }
  }

  once<K extends keyof TEvents>(event: K, listener: TEvents[K]): void {
    const onceWrapper: TEvents[K] = ((...args: any[]) => {
      this.off(event, onceWrapper);
      listener(...args);
    }) as TEvents[K];
    this.on(event, onceWrapper);
  }

  emit<K extends keyof TEvents>(event: K, ...args: Parameters<TEvents[K]>): void {
    const eventListeners = this.listeners.get(event);
    if (eventListeners) {
      eventListeners.forEach((listener) => {
        try {
          listener(...args);
        } catch (error) {
          console.error(`Error in event listener for ${String(event)}:`, error);
        }
      });
    }
  }

  removeAllListeners(event?: keyof TEvents): void {
    if (event) {
      this.listeners.delete(event);
    } else {
      this.listeners.clear();
    }
  }

  /**
   * Get listener count for an event
   */
  getListenerCount(event: keyof TEvents): number {
    return this.listeners.get(event)?.size ?? 0;
  }
}
