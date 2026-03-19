/**
 * WebBridge — the central coordinator between the eca-webview and
 * the ECA remote server.
 *
 * Data flow:
 *   Inbound:  Server → SSE → WebBridge → window.postMessage → Webview
 *   Outbound: Webview → CustomEvent/transport → WebBridge → REST API → Server
 *
 * Responsibilities:
 * - Establish SSE connection and wait for session:connected
 * - Translate SSE events into webview dispatch calls
 * - Route outbound webview messages to REST API calls
 * - Restore chat state on initial connection
 *
 * Heavy logic is delegated to:
 * - chat-restore.ts: message format conversion
 * - outbound-handler.ts: REST API call routing
 */

import { EcaRemoteApi } from './api';
import { chatToRestoreEvents } from './chat-restore';
import { handleOutbound, type OutboundContext } from './outbound-handler';
import { SSEClient, type SSEEvent } from './sse';
import type {
  MCPServerUpdatedParams,
  RemoteChat,
  SessionConfig,
  SessionState,
  SSEChatStatusPayload,
  SSESessionConnectedPayload,
  SSESessionMessagePayload,
} from './types';

/** Timeout for the initial SSE handshake (session:connected). */
const SSE_CONNECT_TIMEOUT_MS = 15_000;

export class WebBridge {
  private api: EcaRemoteApi;
  private sse: SSEClient | null = null;
  private sessionState: SessionState | null = null;
  private connected = false;
  private currentChatId: string | null = null;
  private outboundListener: ((e: Event) => void) | null = null;
  private mcpServers: MCPServerUpdatedParams[] = [];

  /**
   * True while the bridge is restoring chat state from the server.
   * During this window, live `chat:content-received` SSE events are
   * skipped to prevent duplicate messages in the webview.
   */
  private restoring = false;

  constructor(host: string, token: string) {
    this.api = new EcaRemoteApi(host, token);
  }

  // ---------------------------------------------------------------------------
  // Connection lifecycle
  // ---------------------------------------------------------------------------

  async connect(): Promise<void> {
    await this.api.health();
    await this.connectSSE();
    this.registerOutboundHandler();
    this.registerTransport();
  }

  disconnect(): void {
    this.connected = false;
    this.sse?.disconnect();
    this.sse = null;
    window.__ecaWebTransport = undefined;

    if (this.outboundListener) {
      window.removeEventListener('eca-web-send', this.outboundListener);
      this.outboundListener = null;
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  // ---------------------------------------------------------------------------
  // SSE connection
  // ---------------------------------------------------------------------------

  /**
   * Open the SSE stream and wait for the initial session:connected event.
   * Rejects if the connection fails or times out.
   */
  private connectSSE(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('SSE connection timeout')),
        SSE_CONNECT_TIMEOUT_MS,
      );

      this.sse = new SSEClient(
        this.api.sseUrl(),
        this.api.authToken,
        (event) => {
          if (event.event === 'session:connected' && !this.connected) {
            clearTimeout(timeout);
            this.handleSessionConnected(event);
            this.connected = true;
            resolve();
          } else {
            this.handleSSEEvent(event);
          }
        },
        (error) => {
          if (!this.connected) {
            clearTimeout(timeout);
            reject(error);
          } else {
            console.error('[Bridge] SSE error:', error);
          }
        },
        () => {
          console.warn('[Bridge] SSE disconnected');
          this.connected = false;
          this.dispatch('server/statusChanged', 'Stopped');
        },
      );

      this.sse.connect().catch((err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  // ---------------------------------------------------------------------------
  // SSE event handling
  // ---------------------------------------------------------------------------

  private handleSessionConnected(event: SSEEvent): void {
    try {
      const data: SSESessionConnectedPayload = JSON.parse(event.data);
      this.sessionState = {
        workspaceFolders: data.workspaceFolders,
        models: data.models,
        agents: data.agents,
        mcpServers: data.mcpServers,
        chats: data.chats,
        config: this.buildSessionConfig(data),
      };
    } catch (err) {
      console.error('[Bridge] Failed to parse session:connected', err);
    }
  }

  private handleSSEEvent(event: SSEEvent): void {
    // Skip chat content during restore to prevent duplicates
    if (this.restoring && event.event === 'chat:content-received') {
      return;
    }

    try {
      const data = JSON.parse(event.data);

      switch (event.event) {
        case 'chat:content-received':
          this.dispatch('chat/contentReceived', data);
          break;

        case 'chat:cleared':
          this.dispatch('chat/cleared', { chatId: data.chatId, messages: true });
          break;

        case 'chat:deleted':
          this.dispatch('chat/deleted', data.chatId);
          break;

        case 'chat:status-changed': {
          const status = data as SSEChatStatusPayload;
          if (status.status === 'idle') {
            this.dispatch('chat/contentReceived', {
              chatId: status.chatId,
              role: 'system',
              content: { type: 'progress', state: 'finished' },
            });
          } else if (status.status === 'running') {
            this.dispatch('chat/contentReceived', {
              chatId: status.chatId,
              role: 'system',
              content: { type: 'progress', state: 'running', text: 'Running...' },
            });
          }
          break;
        }

        case 'config:updated':
          this.dispatch('config/updated', data);
          break;

        case 'tool:server-updated':
          this.upsertMcpServer(data as MCPServerUpdatedParams);
          break;

        case 'session:message': {
          const msg = data as SSESessionMessagePayload;
          console.log(`[ECA ${msg.type}]`, msg.message);
          break;
        }

        case 'session:disconnecting':
          console.warn('[Bridge] Server shutting down:', data.reason);
          this.dispatch('server/statusChanged', 'Stopped');
          break;
      }
    } catch (err) {
      console.error('[Bridge] Failed to handle SSE event:', event.event, err);
    }
  }

  // ---------------------------------------------------------------------------
  // Initial state dispatch (on webview/ready)
  // ---------------------------------------------------------------------------

  private async dispatchInitialState(): Promise<void> {
    if (!this.sessionState) return;

    this.restoring = true;
    try {
      this.dispatch('server/statusChanged', 'Running');

      if (this.sessionState.workspaceFolders) {
        this.dispatch('server/setWorkspaceFolders', this.sessionState.workspaceFolders);
      }

      if (this.sessionState.config) {
        this.dispatch('config/updated', this.sessionState.config);
      }

      if (this.sessionState.mcpServers) {
        this.mcpServers = [...this.sessionState.mcpServers];
        this.dispatch('tool/serversUpdated', this.mcpServers);
      }

      await this.restoreChats();
    } finally {
      this.restoring = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Chat restoration
  // ---------------------------------------------------------------------------

  /**
   * Restore chats — prefer session:connected data, fall back to REST.
   * Uses chat-restore.ts for message format conversion.
   */
  private async restoreChats(): Promise<void> {
    const sessionChats = this.sessionState?.chats;

    if (sessionChats?.length) {
      console.log(`[Bridge] Restoring ${sessionChats.length} chat(s) from session:connected`);
      this.dispatchChatEvents(sessionChats);
      return;
    }

    // Fallback: fetch from REST API
    try {
      const summaries = await this.api.chats();
      if (!summaries?.length) return;

      console.log(`[Bridge] Fetched ${summaries.length} chat(s) from REST API`);
      const fullChats: RemoteChat[] = [];
      for (const summary of summaries) {
        try {
          const chat = await this.api.getChat(summary.id);
          if (chat) fullChats.push(chat);
        } catch (err) {
          console.error(`[Bridge] Failed to fetch chat ${summary.id}:`, err);
        }
      }
      if (fullChats.length) {
        this.dispatchChatEvents(fullChats);
      }
    } catch (err) {
      console.error('[Bridge] Failed to fetch chat list:', err);
    }
  }

  /** Dispatch restore events for a list of chats. */
  private dispatchChatEvents(chats: RemoteChat[]): void {
    for (const chat of chats) {
      if (!chat?.id) continue;
      this.currentChatId = chat.id;

      const events = chatToRestoreEvents(chat);
      for (const event of events) {
        this.dispatch('chat/contentReceived', event);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Outbound message handling (webview → REST)
  // ---------------------------------------------------------------------------

  /** Register the CustomEvent listener for webview outbound messages. */
  private registerOutboundHandler(): void {
    this.outboundListener = (e: Event) => {
      const msg = (e as CustomEvent).detail;
      if (msg) this.routeOutbound(msg);
    };
    window.addEventListener('eca-web-send', this.outboundListener);
  }

  /** Register on window.__ecaWebTransport for the 'web' editor case. */
  private registerTransport(): void {
    window.__ecaWebTransport = {
      send: (msg: { type: string; data: any }) => this.routeOutbound(msg),
    };
  }

  /** Build the context and delegate to the outbound handler. */
  private routeOutbound(msg: { type: string; data: any }): void {
    const ctx: OutboundContext = {
      api: this.api,
      dispatch: (type, data) => this.dispatch(type, data),
      getCurrentChatId: () => this.currentChatId,
      setCurrentChatId: (id) => { this.currentChatId = id; },
      dispatchInitialState: () => this.dispatchInitialState(),
    };
    handleOutbound(msg, ctx);
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /** Upsert an MCP server and dispatch the full updated list. */
  private upsertMcpServer(server: MCPServerUpdatedParams): void {
    const idx = this.mcpServers.findIndex((s) => s.name === server.name);
    if (idx >= 0) {
      // Immutable update — replace the array instead of mutating
      this.mcpServers = [
        ...this.mcpServers.slice(0, idx),
        server,
        ...this.mcpServers.slice(idx + 1),
      ];
    } else {
      this.mcpServers = [...this.mcpServers, server];
    }
    this.dispatch('tool/serversUpdated', this.mcpServers);
  }

  /** Build session config from the SSE session:connected payload. */
  private buildSessionConfig(data: SSESessionConnectedPayload): SessionConfig {
    return {
      chat: {
        models: (data.models || []).map((m) => m.id || String(m)),
        agents: (data.agents || []).map((a) => a.id || String(a)),
        welcomeMessage: data.welcomeMessage || 'Welcome to ECA Web',
        variants: data.variants || [],
        selectedVariant: data.selectedVariant || null,
      },
    };
  }

  /** Dispatch a message to the webview via window.postMessage. */
  private dispatch(type: string, data: unknown): void {
    window.postMessage({ type, data }, '*');
  }
}
