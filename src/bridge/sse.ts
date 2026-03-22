/**
 * SSEClient — Server-Sent Events client using the Fetch API.
 *
 * Uses ReadableStream to parse the SSE text/event-stream format,
 * with heartbeat detection to auto-disconnect on stale connections.
 *
 * The server sends periodic `:heartbeat` comments to keep the
 * connection alive. If no data arrives within the heartbeat window,
 * the client assumes the connection is dead and triggers onDisconnect.
 */

import { localNetworkFetchOptions } from './utils';

export interface SSEEvent {
  event: string;
  data: string;
}

type EventHandler = (event: SSEEvent) => void;
type ErrorHandler = (error: Error) => void;

/** Default heartbeat timeout in milliseconds (35 seconds). */
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 35_000;

export interface SSEClientOptions {
  /** Heartbeat timeout in ms. If no data arrives within this window, disconnect. */
  heartbeatTimeoutMs?: number;
}

export class SSEClient {
  private url: string;
  private password: string;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private abortController: AbortController | null = null;
  private onEvent: EventHandler;
  private onError: ErrorHandler;
  private onDisconnect: () => void;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimeoutMs: number;
  private running = false;

  constructor(
    url: string,
    password: string,
    onEvent: EventHandler,
    onError: ErrorHandler,
    onDisconnect: () => void,
    options: SSEClientOptions = {},
  ) {
    this.url = url;
    this.password = password;
    this.onEvent = onEvent;
    this.onError = onError;
    this.onDisconnect = onDisconnect;
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
  }

  /**
   * Open the SSE stream. Throws if the initial HTTP request fails.
   * Safe to call again after a `disconnect()` — resets internal state first.
   */
  async connect(): Promise<void> {
    // Clean up any leftover state from a previous connection
    this.cleanUp();

    this.running = true;
    this.abortController = new AbortController();

    const response = await fetch(this.url, {
      ...localNetworkFetchOptions(this.url),
      headers: { 'Authorization': `Bearer ${this.password}` },
      signal: this.abortController.signal,
    });

    if (!response.ok) {
      throw new Error(`SSE connection failed: ${response.status}`);
    }

    if (!response.body) {
      throw new Error('SSE response has no body');
    }

    this.reader = response.body.getReader();
    this.resetHeartbeatTimer();
    this.readLoop();
  }

  /** Cleanly close the SSE stream. Safe to call multiple times. */
  disconnect(): void {
    this.running = false;
    this.cleanUp();
  }

  /** Release resources without changing the `running` flag. */
  private cleanUp(): void {
    this.clearHeartbeatTimer();
    this.abortController?.abort();
    this.reader?.cancel().catch(() => {});
    this.reader = null;
    this.abortController = null;
  }

  // ---------------------------------------------------------------------------
  // Heartbeat
  // ---------------------------------------------------------------------------

  private resetHeartbeatTimer(): void {
    this.clearHeartbeatTimer();
    this.heartbeatTimer = setTimeout(() => {
      if (this.running) {
        console.warn('[SSE] Heartbeat timeout — assuming disconnected');
        this.disconnect();
        this.onDisconnect();
      }
    }, this.heartbeatTimeoutMs);
  }

  private clearHeartbeatTimer(): void {
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Read loop
  // ---------------------------------------------------------------------------

  private async readLoop(): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (this.running && this.reader) {
        const { done, value } = await this.reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        this.resetHeartbeatTimer();

        const { parsed, remaining } = parseSSEBuffer(buffer);
        buffer = remaining;

        for (const evt of parsed) {
          this.onEvent(evt);
        }
      }
    } catch (err: any) {
      if (err.name === 'AbortError') return;
      if (this.running) this.onError(err);
    } finally {
      if (this.running) {
        this.running = false;
        this.onDisconnect();
      }
    }
  }
}

// ---------------------------------------------------------------------------
// SSE parser (pure function, exported for testability)
// ---------------------------------------------------------------------------

/**
 * Parse an SSE text buffer into discrete events.
 *
 * SSE format: events are separated by blank lines (`\n\n`).
 * Each event block contains `event:` and `data:` lines.
 * Lines starting with `:` are comments (e.g. heartbeats).
 *
 * Returns the parsed events and any incomplete trailing data.
 */
export function parseSSEBuffer(buffer: string): {
  parsed: SSEEvent[];
  remaining: string;
} {
  const parsed: SSEEvent[] = [];
  const blocks = buffer.split('\n\n');

  // Last block may be incomplete — keep it for next iteration
  const remaining = blocks.pop() || '';

  for (const block of blocks) {
    if (!block.trim()) continue;

    let eventType = '';
    let data = '';

    for (const line of block.split('\n')) {
      if (line.startsWith(':')) {
        // Comment (heartbeat) — ignore
        continue;
      }
      if (line.startsWith('event:')) {
        eventType = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        data += (data ? '\n' : '') + line.slice(5).trim();
      }
    }

    if (eventType && data) {
      parsed.push({ event: eventType, data });
    }
  }

  return { parsed, remaining };
}
