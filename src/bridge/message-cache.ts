/**
 * Message cache — singleton in-memory cache for chat messages.
 *
 * Lives outside WebBridge so it survives bridge destruction (e.g. tab
 * switching, reconnection). Keyed by server host + chatId to avoid
 * cross-server pollution in multi-connection scenarios.
 *
 * Design:
 * - Staleness TTL (default 5 min) — stale entries are treated as misses
 * - LRU eviction when max entry count is exceeded
 * - Incremental updates via appendEvent() to keep cache fresh from SSE
 */

import type { RemoteChat, StoredMessage } from './types';

/** A cached chat entry with metadata for staleness checks. */
export interface CachedChat {
  /** The full chat object (with messages) as returned by the REST API. */
  chat: RemoteChat;
  /** Timestamp (epoch ms) of when this entry was last written or updated. */
  timestamp: number;
}

/** Configuration for the message cache. */
interface MessageCacheConfig {
  /** Maximum number of cached chats (default: 20). */
  maxEntries: number;
  /** Time-to-live in milliseconds before an entry is considered stale (default: 5 min). */
  staleTTL: number;
}

const DEFAULT_CONFIG: MessageCacheConfig = {
  maxEntries: 20,
  staleTTL: 5 * 60 * 1000, // 5 minutes
};

/**
 * In-memory LRU cache for chat message history.
 *
 * Entries are keyed by `${host}::${chatId}` so multiple server
 * connections can coexist without interference.
 */
export class MessageCache {
  private cache = new Map<string, CachedChat>();
  private config: MessageCacheConfig;

  constructor(config: Partial<MessageCacheConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /** Build the composite cache key. */
  private key(host: string, chatId: string): string {
    return `${host}::${chatId}`;
  }

  /**
   * Retrieve a cached chat if it exists and is not stale.
   * Returns `null` on miss or staleness.
   */
  get(host: string, chatId: string): CachedChat | null {
    const k = this.key(host, chatId);
    const entry = this.cache.get(k);
    if (!entry) return null;

    // Staleness check
    if (Date.now() - entry.timestamp > this.config.staleTTL) {
      this.cache.delete(k);
      return null;
    }

    // LRU touch: delete + re-insert to move to end (most recent)
    this.cache.delete(k);
    this.cache.set(k, entry);
    return entry;
  }

  /** Check if a fresh (non-stale) cache entry exists. */
  has(host: string, chatId: string): boolean {
    return this.get(host, chatId) !== null;
  }

  /**
   * Store a full chat in the cache (typically after a REST fetch).
   * Evicts the oldest entry if the cache is full.
   */
  set(host: string, chatId: string, chat: RemoteChat): void {
    const k = this.key(host, chatId);

    // Delete first for LRU ordering (re-insert at end)
    this.cache.delete(k);

    // Evict oldest (first entry in Map iteration order) if at capacity
    if (this.cache.size >= this.config.maxEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) {
        this.cache.delete(oldest);
      }
    }

    this.cache.set(k, {
      chat: { ...chat, messages: chat.messages ? [...chat.messages] : [] },
      timestamp: Date.now(),
    });
  }

  /**
   * Append a stored message to a cached chat (incremental SSE update).
   * If the chat is not cached, this is a no-op.
   */
  appendMessage(host: string, chatId: string, message: StoredMessage): void {
    const k = this.key(host, chatId);
    const entry = this.cache.get(k);
    if (!entry) return;

    entry.chat.messages = [...(entry.chat.messages ?? []), message];
    entry.timestamp = Date.now();
  }

  /**
   * Update the status of a cached chat (e.g. running → idle).
   * If the chat is not cached, this is a no-op.
   */
  updateStatus(host: string, chatId: string, status: 'idle' | 'running'): void {
    const k = this.key(host, chatId);
    const entry = this.cache.get(k);
    if (!entry) return;

    entry.chat.status = status;
    entry.timestamp = Date.now();
  }

  /** Invalidate (remove) a single chat entry. */
  invalidate(host: string, chatId: string): void {
    this.cache.delete(this.key(host, chatId));
  }

  /** Invalidate all entries for a specific server host. */
  invalidateAll(host: string): void {
    const prefix = `${host}::`;
    for (const key of [...this.cache.keys()]) {
      if (key.startsWith(prefix)) {
        this.cache.delete(key);
      }
    }
  }

  /** Clear the entire cache. */
  clear(): void {
    this.cache.clear();
  }

  /** Number of entries currently in the cache. */
  get size(): number {
    return this.cache.size;
  }
}

/**
 * Module-level singleton cache instance.
 *
 * Imported by WebBridge and other consumers. Because this lives at
 * module scope, it survives bridge destruction and React unmount/remount
 * cycles — enabling instant restore on tab switches and reconnections.
 */
export const messageCache = new MessageCache();
