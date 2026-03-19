export interface SSEEvent {
  event: string;
  data: string;
}

type EventHandler = (event: SSEEvent) => void;
type ErrorHandler = (error: Error) => void;

export class SSEClient {
  private url: string;
  private token: string;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private abortController: AbortController | null = null;
  private onEvent: EventHandler;
  private onError: ErrorHandler;
  private onDisconnect: () => void;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(
    url: string,
    token: string,
    onEvent: EventHandler,
    onError: ErrorHandler,
    onDisconnect: () => void,
  ) {
    this.url = url;
    this.token = token;
    this.onEvent = onEvent;
    this.onError = onError;
    this.onDisconnect = onDisconnect;
  }

  async connect(): Promise<void> {
    this.running = true;
    this.abortController = new AbortController();

    const response = await fetch(this.url, {
      headers: { 'Authorization': `Bearer ${this.token}` },
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

  disconnect(): void {
    this.running = false;
    this.clearHeartbeatTimer();
    this.abortController?.abort();
    this.reader?.cancel().catch(() => {});
    this.reader = null;
  }

  private resetHeartbeatTimer(): void {
    this.clearHeartbeatTimer();
    this.heartbeatTimer = setTimeout(() => {
      if (this.running) {
        console.warn('[SSE] Heartbeat timeout — assuming disconnected');
        this.disconnect();
        this.onDisconnect();
      }
    }, 35000);
  }

  private clearHeartbeatTimer(): void {
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private async readLoop(): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (this.running && this.reader) {
        const { done, value } = await this.reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        this.resetHeartbeatTimer();

        const events = this.parseBuffer(buffer);
        buffer = events.remaining;

        for (const evt of events.parsed) {
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

  private parseBuffer(buffer: string): { parsed: SSEEvent[]; remaining: string } {
    const parsed: SSEEvent[] = [];
    const blocks = buffer.split('\n\n');

    // Last block may be incomplete
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
}
