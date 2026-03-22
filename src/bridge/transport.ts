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
import type { Protocol } from './utils';
import type {
  ChatEntry,
  ChatListChangeCallback,
  ChatSummary,
  MCPServerUpdatedParams,
  ReconnectionCallback,
  ReconnectionState,
  SessionConfig,
  SessionState,
  SSEChatStatusPayload,
  SSESessionConnectedPayload,
  SSESessionMessagePayload,
  SSETrustUpdatedPayload,
} from './types';

/** Timeout for the initial SSE handshake (session:connected). */
const SSE_CONNECT_TIMEOUT_MS = 15_000;

/** Base delay between reconnection attempts (exponential backoff). */
const RECONNECT_BASE_DELAY_MS = 1_000;
/** Maximum delay between reconnection attempts. */
const RECONNECT_MAX_DELAY_MS = 15_000;

export class WebBridge {
  private api: EcaRemoteApi;
  private sse: SSEClient | null = null;
  private sessionState: SessionState | null = null;
  private connected = false;
  private currentChatId: string | null = null;
  private outboundListener: ((e: Event) => void) | null = null;
  private mcpServers: MCPServerUpdatedParams[] = [];

  // --- Reconnection state ---
  private reconnecting = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private onReconnectionChange: ReconnectionCallback | null = null;
  /** Set to true once the bridge has successfully connected at least once. */
  private hasConnectedOnce = false;

  /**
   * Lightweight chat index exposed to the React shell for the sidebar.
   * Kept in sync as chat events flow through the bridge.
   */
  private chatEntries: ChatEntry[] = [];

  /** Callback invoked whenever the chat list or selection changes. */
  private onChatListChange: ChatListChangeCallback | null = null;

  /**
   * IDs of chats whose messages have already been fetched and dispatched.
   * Used to avoid redundant loads when switching back to a previously viewed chat.
   */
  private loadedChatIds = new Set<string>();

  /**
   * True after `disconnect()` has been called. Checked after every async
   * boundary in `connect()` so that orphaned bridges (e.g. from React
   * StrictMode mount-unmount-mount) abort instead of opening a second
   * SSE connection.
   */
  private disposed = false;

  /**
   * True while the bridge is restoring chat state from the server.
   * During this window, live `chat:content-received` SSE events are
   * skipped to prevent duplicate messages in the webview.
   */
  private restoring = false;

  /**
   * True after `dispatchInitialState()` has executed once.  Prevents
   * React StrictMode's double `webview/ready` from restoring the same
   * chat state twice.
   */
  private initialStateDispatched = false;

  /**
   * Chat IDs known to belong to subagents. These are excluded from
   * the sidebar to avoid cluttering the chat list with internal
   * agent-spawned conversations.
   */
  private subagentChatIds = new Set<string>();

  constructor(host: string, password: string, protocol?: Protocol) {
    this.api = new EcaRemoteApi(host, password, protocol);
  }

  // ---------------------------------------------------------------------------
  // Connection lifecycle
  // ---------------------------------------------------------------------------

  async connect(): Promise<void> {
    await this.api.health();
    if (this.disposed) return;

    await this.connectSSE();
    if (this.disposed) return;

    this.hasConnectedOnce = true;
    this.registerOutboundHandler();
    this.registerTransport();
  }

  disconnect(): void {
    this.disposed = true;
    this.connected = false;
    this.cleanUpReconnect();
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

  /** Whether the bridge is currently attempting to reconnect. */
  isReconnecting(): boolean {
    return this.reconnecting;
  }

  /** Register a callback for reconnection state changes. */
  onReconnection(cb: ReconnectionCallback): void {
    this.onReconnectionChange = cb;
  }

  // ---------------------------------------------------------------------------
  // Auto-reconnection
  // ---------------------------------------------------------------------------

  /**
   * Attempt to re-establish the SSE connection with exponential backoff.
   *
   * Called automatically when an established SSE connection drops
   * (heartbeat timeout, stream end, network error). Does NOT fire for
   * initial connection failures — those are surfaced to the caller of
   * `connect()` directly.
   *
   * During reconnection the webview stays mounted with its full chat
   * history; only the live SSE stream is re-opened.
   */
  private scheduleReconnect(): void {
    if (this.disposed || this.reconnecting) return;
    this.reconnecting = true;
    this.reconnectAttempt = 0;
    this.attemptReconnect();
  }

  private attemptReconnect(): void {
    if (this.disposed) {
      this.cleanUpReconnect();
      return;
    }

    this.reconnectAttempt++;
    const delay = Math.min(
      RECONNECT_BASE_DELAY_MS * Math.pow(2, this.reconnectAttempt - 1),
      RECONNECT_MAX_DELAY_MS,
    );

    console.log(
      `[Bridge] Reconnect attempt #${this.reconnectAttempt} in ${delay}ms`,
    );

    this.notifyReconnection({
      status: 'reconnecting',
      attempt: this.reconnectAttempt,
      nextRetryMs: delay,
    });

    this.reconnectTimer = setTimeout(async () => {
      if (this.disposed) {
        this.cleanUpReconnect();
        return;
      }

      try {
        // Quick health check first — fail fast if server is unreachable
        await this.api.health();
        if (this.disposed) return;

        // Re-open SSE
        await this.reconnectSSE();
        if (this.disposed) return;

        // Success!
        console.log(`[Bridge] Reconnected after ${this.reconnectAttempt} attempt(s)`);
        this.reconnecting = false;
        this.reconnectAttempt = 0;

        // Re-sync server state with the webview
        await this.syncAfterReconnect();

        this.notifyReconnection({
          status: 'reconnected',
          attempt: this.reconnectAttempt,
        });
      } catch (err) {
        console.warn('[Bridge] Reconnect attempt failed:', err);
        if (!this.disposed) {
          this.attemptReconnect();
        }
      }
    }, delay);
  }

  /**
   * Re-open the SSE stream (without the full connect() ceremony).
   * Rejects if the handshake times out or the connection fails.
   */
  private reconnectSSE(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('SSE reconnect timeout')),
        SSE_CONNECT_TIMEOUT_MS,
      );

      // Disconnect old SSE if it still exists
      this.sse?.disconnect();

      this.sse = new SSEClient(
        this.api.sseUrl(),
        this.api.authPassword,
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
          this.scheduleReconnect();
        },
      );

      this.sse.connect().catch((err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  /**
   * After a successful reconnect, refresh session config and re-dispatch
   * a "Running" status so the webview knows the server is back.
   */
  private async syncAfterReconnect(): Promise<void> {
    if (!this.sessionState) return;

    // Re-dispatch workspace and config in case the server restarted
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
    this.dispatch('server/setTrust', this.sessionState.trust ?? false);
    this.dispatch('server/statusChanged', 'Running');
  }

  private notifyReconnection(state: ReconnectionState): void {
    this.onReconnectionChange?.(state);
  }

  private cleanUpReconnect(): void {
    this.reconnecting = false;
    this.reconnectAttempt = 0;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Chat list API (for the sidebar)
  // ---------------------------------------------------------------------------

  /** Register a listener for chat list changes (used by the sidebar). */
  onChatListChanged(cb: ChatListChangeCallback): void {
    this.onChatListChange = cb;
    // Immediately fire with current state
    cb([...this.chatEntries], this.currentChatId);
  }

  /** Get the current chat entries snapshot. */
  getChatEntries(): ChatEntry[] {
    return [...this.chatEntries];
  }

  /** Get the currently selected chat ID. */
  getSelectedChatId(): string | null {
    return this.currentChatId;
  }

  /** Select a chat by ID — dispatches to the webview, loads messages if needed. */
  async selectChat(chatId: string): Promise<void> {
    this.currentChatId = chatId;

    const alreadyLoaded = this.loadedChatIds.has(chatId);
    if (alreadyLoaded) {
      // Chat already exists in webview Redux — just switch to it.
      this.dispatch('chat/selectChat', chatId);
    } else {
      // Fetch and dispatch content events. The first contentReceived event
      // auto-creates the chat in Redux and sets it as selectedChat, so we
      // don't need a separate selectChat dispatch (which would race).
      await this.loadChatMessages(chatId);
    }

    this.notifyChatListChange();
  }

  /** Create a new chat — dispatches to the webview. */
  newChat(): void {
    this.dispatch('chat/createNewChat', undefined);
  }

  /** Delete a chat by ID — calls the REST API. */
  async deleteChatFromSidebar(chatId: string): Promise<void> {
    try {
      await this.api.deleteChat(chatId);
    } catch (err) {
      console.error('[Bridge] Failed to delete chat:', err);
    }
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
        this.api.authPassword,
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

          // Auto-reconnect if this was a previously-established connection
          if (this.hasConnectedOnce && !this.disposed) {
            this.scheduleReconnect();
          }
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
        trust: data.trust ?? false,
        startedAt: data.startedAt,
      };
    } catch (err) {
      console.error('[Bridge] Failed to parse session:connected', err);
    }
  }

  private handleSSEEvent(event: SSEEvent): void {
    if (this.disposed) return;

    // Skip chat content during restore to prevent duplicates
    if (this.restoring && event.event === 'chat:content-received') {
      return;
    }

    try {
      const data = JSON.parse(event.data);

      switch (event.event) {
        case 'chat:content-received':
          this.dispatch('chat/contentReceived', data);

          // Track subagent chat IDs so they never appear in the sidebar.
          if (data.parentChatId && data.chatId) {
            this.subagentChatIds.add(data.chatId);
          }

          // Track new chats and title updates for the sidebar.
          // Skip subagent chats — they render inside the parent chat's tool call.
          if (data.chatId && !this.subagentChatIds.has(data.chatId)) {
            this.loadedChatIds.add(data.chatId);
            this.upsertChatEntry(data.chatId, {});
            if (data.content?.type === 'metadata' && data.content?.title) {
              this.upsertChatEntry(data.chatId, { title: data.content.title });
            }
            this.notifyChatListChange();
          }
          break;

        case 'chat:cleared':
          this.dispatch('chat/cleared', { chatId: data.chatId, messages: true });
          this.loadedChatIds.delete(data.chatId);
          break;

        case 'chat:deleted':
          this.dispatch('chat/deleted', data.chatId);
          this.removeChatEntry(data.chatId);
          this.loadedChatIds.delete(data.chatId);
          this.notifyChatListChange();
          break;

        case 'chat:status-changed': {
          const status = data as SSEChatStatusPayload;
          // Only update sidebar for non-subagent chats
          if (!this.subagentChatIds.has(status.chatId)) {
            this.upsertChatEntry(status.chatId, { status: status.status });
            this.notifyChatListChange();
          }
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

        case 'trust:updated': {
          const trustData = data as SSETrustUpdatedPayload;
          this.dispatch('server/setTrust', trustData.trust);
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
    if (this.initialStateDispatched || !this.sessionState) return;
    this.initialStateDispatched = true;

    this.restoring = true;
    try {
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

      // Sync trust mode from server state
      this.dispatch('server/setTrust', this.sessionState.trust ?? false);

      // Load chat summaries + most recent chat messages BEFORE marking
      // the server as running — the webview renders the Chat component
      // once it sees "Running", so chats must be populated first.
      await this.restoreChats();

      this.dispatch('server/statusChanged', 'Running');
    } finally {
      this.restoring = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Chat restoration (lazy-load)
  // ---------------------------------------------------------------------------

  /**
   * Populate the sidebar with chat summaries from session:connected (or REST
   * fallback). Messages are NOT loaded here — they are fetched on demand when
   * the user selects a chat via `loadChatMessages()`.
   *
   * When the server provides a `startedAt` timestamp, only chats that were
   * created or updated since the server started are shown. This prevents the
   * sidebar from filling up with stale chats from previous server sessions.
   * Chats that a user resumed (updated) after the server started are included.
   */
  private async restoreChats(): Promise<void> {
    let summaries: ChatSummary[] | undefined = this.sessionState?.chats;

    // Fallback: fetch summaries from REST if session:connected had none
    if (!summaries?.length) {
      try {
        summaries = await this.api.chats();
      } catch (err) {
        console.error('[Bridge] Failed to fetch chat list:', err);
        return;
      }
    }

    if (!summaries?.length) return;

    // Exclude subagent chats — they are rendered inside their parent chat's
    // tool call card, not as standalone sidebar entries.
    summaries = summaries.filter((s) => {
      if (s.parentChatId) {
        this.subagentChatIds.add(s.id);
        return false;
      }
      return true;
    });

    if (!summaries?.length) return;

    // Filter to only show chats from the current server session.
    // A chat qualifies if it was created or updated after the server started,
    // or if it is currently running (active right now).
    const serverStartedAt = this.sessionState?.startedAt;
    if (serverStartedAt) {
      const startTime = new Date(serverStartedAt).getTime();
      const before = summaries.length;
      summaries = summaries.filter((s) => {
        // Always show currently running chats
        if (s.status === 'running') return true;
        // Show if updated (resumed) since server started.
        // Timestamps may be epoch millis (number) or ISO strings.
        const updated = s.updatedAt ? new Date(s.updatedAt).getTime() : 0;
        if (updated >= startTime) return true;
        // Show if created since server started (and never updated)
        if (!s.updatedAt) {
          const created = s.createdAt ? new Date(s.createdAt).getTime() : 0;
          if (created >= startTime) return true;
        }
        return false;
      });
      console.log(`[Bridge] Filtered chats: ${before} total → ${summaries.length} from current session`);
    }

    if (!summaries?.length) return;

    console.log(`[Bridge] Populating sidebar with ${summaries.length} chat(s)`);

    // Register sidebar entries for every chat (no messages dispatched)
    for (const summary of summaries) {
      if (!summary?.id) continue;
      this.upsertChatEntry(summary.id, {
        title: summary.title ?? 'Chat',
        status: summary.status ?? 'idle',
      });
    }

    // Auto-select and load the most recent chat
    const lastChat = summaries[summaries.length - 1];
    if (lastChat?.id) {
      this.currentChatId = lastChat.id;
      await this.loadChatMessages(lastChat.id);
    }

    this.notifyChatListChange();
  }

  /**
   * Lazy-load a single chat's messages from the server and dispatch them
   * to the webview. Skips if the chat was already loaded.
   *
   * Called automatically on initial connect (for the most recent chat)
   * and on demand when the user switches chats.
   */
  async loadChatMessages(chatId: string): Promise<void> {
    if (this.loadedChatIds.has(chatId)) return;

    try {
      console.log(`[Bridge] Loading messages for chat ${chatId}`);
      const chat = await this.api.getChat(chatId);
      this.loadedChatIds.add(chatId);

      const events = chatToRestoreEvents(chat);

      // Always dispatch at least one event so the webview's Redux store
      // creates the chat entry (the addContentReceived reducer auto-creates
      // chats on first content). For empty chats, send a metadata event.
      if (events.length === 0) {
        events.push({
          chatId,
          role: 'system' as const,
          content: { type: 'metadata', title: chat?.title ?? 'Chat' },
        });
      }

      for (const event of events) {
        this.dispatch('chat/contentReceived', event);
      }

      console.log(`[Bridge] Loaded ${chat?.messages?.length ?? 0} message(s) for chat ${chatId}`);
    } catch (err) {
      console.error(`[Bridge] Failed to load messages for chat ${chatId}:`, err);
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
      loadChatMessages: (chatId) => this.loadChatMessages(chatId),
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
        selectModel: data.selectModel,
        selectAgent: data.selectAgent,
        variants: data.variants || [],
        selectedVariant: data.selectedVariant || null,
      },
    };
  }

  /** Dispatch a message to the webview via window.postMessage. */
  private dispatch(type: string, data: unknown): void {
    window.postMessage({ type, data }, '*');
  }

  // ---------------------------------------------------------------------------
  // Chat entry tracking (for sidebar)
  // ---------------------------------------------------------------------------

  /** Notify the sidebar callback of chat list changes. */
  private notifyChatListChange(): void {
    this.onChatListChange?.([...this.chatEntries], this.currentChatId);
  }

  /** Upsert a chat entry by ID (creates if missing, updates if present). */
  private upsertChatEntry(id: string, partial: Partial<Omit<ChatEntry, 'id'>>): void {
    const idx = this.chatEntries.findIndex((e) => e.id === id);
    if (idx >= 0) {
      this.chatEntries = [
        ...this.chatEntries.slice(0, idx),
        { ...this.chatEntries[idx], ...partial },
        ...this.chatEntries.slice(idx + 1),
      ];
    } else {
      this.chatEntries = [
        ...this.chatEntries,
        { id, title: partial.title ?? `Chat`, status: partial.status ?? 'idle' },
      ];
    }
  }

  /** Remove a chat entry by ID. */
  private removeChatEntry(id: string): void {
    this.chatEntries = this.chatEntries.filter((e) => e.id !== id);
  }
}
