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
import { messageCache } from './message-cache';
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
  TrustChangeCallback,
  WorkspaceFolder,
} from './types';

/** Timeout for the initial SSE handshake (session:connected). */
const SSE_CONNECT_TIMEOUT_MS = 15_000;

/** Base delay between reconnection attempts (exponential backoff). */
const RECONNECT_BASE_DELAY_MS = 1_000;
/** Maximum delay between reconnection attempts. */
const RECONNECT_MAX_DELAY_MS = 15_000;
/** Maximum number of reconnection attempts before giving up (~5 min with backoff). */
const MAX_RECONNECT_ATTEMPTS = 30;

export class WebBridge {
  private api: EcaRemoteApi;
  private host: string;
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

  /** Callback invoked whenever trust mode changes. */
  private onTrustChange: TrustChangeCallback | null = null;

  /**
   * IDs of chats whose full message history has been fetched from the REST API
   * and dispatched to the webview. Used to avoid redundant loads when switching
   * back to a previously viewed chat.
   *
   * Note: chats that only received live SSE events (e.g. a running chat that
   * started streaming before the user opened it) are NOT in this set — they
   * need a full REST fetch to load the earlier messages.
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
   * During this window, all chat-mutating SSE events are queued and
   * replayed after restoration completes to prevent duplicates and
   * state corruption (e.g. a `chat:deleted` arriving mid-restore
   * could remove a chat being actively restored).
   */
  private restoring = false;

  /**
   * SSE events queued while `restoring` is true. These are replayed
   * in order after restore completes via `flushRestoreQueue()`.
   */
  private restoreQueue: SSEEvent[] = [];

  /**
   * Counter for automatic restore retries (on transient failures).
   * Prevents unbounded retry loops when the server is persistently
   * unreachable. Reset to 0 on successful chat load.
   */
  private restoreRetryCount = 0;
  private static readonly MAX_RESTORE_RETRIES = 3;

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

  /**
   * The preferred chat ID to restore on connect. When set (e.g. from
   * persisted storage), `restoreChats()` will select this chat instead
   * of the most recent one — giving the user continuity across sessions.
   */
  private preferredChatId: string | null = null;

  constructor(host: string, password: string, protocol?: Protocol, lastChatId?: string) {
    this.host = host;
    this.api = new EcaRemoteApi(host, password, protocol);
    this.preferredChatId = lastChatId ?? null;
  }

  // ---------------------------------------------------------------------------
  // Connection lifecycle
  // ---------------------------------------------------------------------------

  async connect(): Promise<void> {
    await this.api.health();
    if (this.disposed) return;

    await this.connectSSE();
    if (this.disposed) return;

    // Note: hasConnectedOnce is set inside the SSE session:connected callback
    // (before this promise resolves) to prevent a race where an immediate SSE
    // disconnect between resolve() and here would dispatch 'Stopped'.
    this.registerOutboundHandler();
    this.registerTransport();
  }

  disconnect(): void {
    this.disposed = true;
    this.connected = false;
    this.cleanUpReconnect();
    this.restoreQueue = [];
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

    // Give up after too many attempts
    if (this.reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
      console.warn(`[Bridge] Giving up after ${this.reconnectAttempt} reconnect attempts`);
      this.reconnecting = false;
      this.notifyReconnection({
        status: 'failed',
        attempt: this.reconnectAttempt,
        retryNow: () => this.retryNow(),
      });
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
      retryNow: () => this.retryNow(),
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
   * Manually trigger a reconnection attempt (e.g. from a "Retry Now" button).
   * Resets the attempt counter and starts a fresh reconnection cycle.
   */
  retryNow(): void {
    if (this.disposed) return;

    // Clear any pending scheduled retry
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.reconnectAttempt = 0;
    this.reconnecting = true;
    this.attemptReconnect();
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
          console.warn('[Bridge] SSE disconnected (reconnect path)');
          this.connected = false;
          // Don't dispatch 'Stopped' here — preserve chat state in the webview.
          // The reconnection overlay communicates connection status to the user.
          if (!this.disposed) {
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

  /**
   * After a successful reconnect, refresh session config, re-sync chats,
   * and re-dispatch a "Running" status so the webview knows the server is back.
   *
   * Unlike the initial `dispatchInitialState()`, this does NOT reset the
   * webview entirely — it preserves the current chat view and incrementally
   * updates it with the latest server state.
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

    // Ensure the webview knows the server is running before we re-sync chats,
    // so the UI is responsive while messages are being restored.
    this.dispatch('server/statusChanged', 'Running');

    // Re-sync chats: clear loaded state so chats are re-fetched with latest
    // server data. Messages that arrived during the disconnect gap will be
    // picked up by the REST fetch. The restoring flag prevents live SSE events
    // from racing with the restore.
    this.restoring = true;
    try {
      this.loadedChatIds.clear();
      await this.restoreChats();
    } catch (err) {
      console.error('[Bridge] Failed to re-sync chats after reconnect:', err);
    } finally {
      this.restoring = false;
      this.flushRestoreQueue();
    }
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

  /** Get the workspace folders from the current session (may be plain path strings). */
  getWorkspaceFolders(): (WorkspaceFolder | string)[] {
    return (this.sessionState?.workspaceFolders as (WorkspaceFolder | string)[] | undefined) ?? [];
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
      const result = await this.loadChatMessages(chatId);

      if (result === 'not_found') {
        // Chat was deleted on the server — remove stale sidebar entry.
        this.removeChatEntry(chatId);
        this.currentChatId = null;
      } else if (!this.loadedChatIds.has(chatId)) {
        // Transient failure — still switch to the chat so the sidebar
        // selection stays consistent. The webview will show the chat
        // even if empty, and a future retry can populate it.
        this.dispatch('chat/selectChat', chatId);
      }
    }

    this.notifyChatListChange();
  }

  /** Create a new chat — dispatches to the webview. */
  newChat(): void {
    this.dispatch('chat/createNewChat', undefined);
  }



  // ---------------------------------------------------------------------------
  // Trust API (for the shell layer)
  // ---------------------------------------------------------------------------

  /** Register a listener for trust state changes. */
  onTrustChanged(cb: TrustChangeCallback): void {
    this.onTrustChange = cb;
    // Immediately fire with current state
    cb(this.sessionState?.trust ?? false);
  }

  /** Get the current trust mode. */
  getTrust(): boolean {
    return this.sessionState?.trust ?? false;
  }

  /** Toggle trust mode — calls the REST API and lets the SSE event confirm the change. */
  async toggleTrust(): Promise<void> {
    const newTrust = !(this.sessionState?.trust ?? false);
    try {
      await this.api.setTrust(newTrust);
    } catch (err) {
      console.error('[Bridge] Failed to toggle trust:', err);
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
            // Mark as connected-once BEFORE resolving so the disconnect
            // handler (which can fire at any time) never sees a half-state
            // where connected=true but hasConnectedOnce=false — that gap
            // would cause a spurious 'Stopped' dispatch that clears chats.
            this.hasConnectedOnce = true;
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

          // Auto-reconnect if this was a previously-established connection.
          // Don't dispatch 'Stopped' during reconnection — this preserves the
          // webview's chat state (the 'Stopped' status clears all chats in Redux).
          // The reconnection overlay communicates the connection status to the user.
          if (this.hasConnectedOnce && !this.disposed) {
            this.scheduleReconnect();
          } else {
            // Terminal disconnect (initial failure or disposed) — clear state
            this.dispatch('server/statusChanged', 'Stopped');
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
      };
    } catch (err) {
      console.error('[Bridge] Failed to parse session:connected', err);
      // Build a minimal sessionState so dispatchInitialState() doesn't
      // bail out entirely. Without this, a parse failure leaves the webview
      // stuck on "Waiting for server to start" with no indication of error.
      this.sessionState = {
        chats: [],
        config: { chat: { models: [], agents: [], welcomeMessage: 'Welcome to ECA Web', variants: [], selectedVariant: null } },
        trust: false,
      };
    }
  }

  /** SSE event types that mutate chat state and must be queued during restore. */
  private static readonly RESTORE_QUEUED_EVENTS = new Set([
    'chat:content-received',
    'chat:status-changed',
    'chat:cleared',
    'chat:deleted',
    'chat:opened',
  ]);

  private handleSSEEvent(event: SSEEvent): void {
    if (this.disposed) return;

    // Queue all chat-mutating events while restoring to prevent duplicates,
    // ghost chats from `chat:status-changed`, and state corruption from
    // `chat:cleared`/`chat:deleted` arriving mid-restore. Queued events
    // are replayed in order after restoration completes.
    if (this.restoring && WebBridge.RESTORE_QUEUED_EVENTS.has(event.event)) {
      this.restoreQueue.push(event);
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
          // Note: we do NOT add to loadedChatIds here — live SSE events only
          // carry new content, not the full history. A full REST fetch is needed
          // when the user selects this chat to load earlier messages.
          if (data.chatId && !this.subagentChatIds.has(data.chatId)) {
            this.upsertChatEntry(data.chatId, {});
            if (data.content?.type === 'metadata' && data.content?.title) {
              this.upsertChatEntry(data.chatId, { title: data.content.title });
            }
            this.notifyChatListChange();

            // Keep the message cache incrementally updated so that reconnects
            // and tab switches can restore from cache without a full REST fetch.
            // We invalidate the cache entry so the next load gets fresh data,
            // since SSE events don't carry the full StoredMessage format.
            messageCache.invalidate(this.host, data.chatId);
          }
          break;

        case 'chat:cleared':
          this.dispatch('chat/cleared', { chatId: data.chatId, messages: true });
          this.loadedChatIds.delete(data.chatId);
          messageCache.invalidate(this.host, data.chatId);
          break;

        case 'chat:deleted':
          this.dispatch('chat/deleted', data.chatId);
          this.removeChatEntry(data.chatId);
          this.loadedChatIds.delete(data.chatId);
          messageCache.invalidate(this.host, data.chatId);
          this.notifyChatListChange();
          break;

        case 'chat:opened':
          this.dispatch('chat/opened', data);
          this.upsertChatEntry(data.chatId, { title: data.title });
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
          if (this.sessionState) {
            this.sessionState.trust = trustData.trust;
          }
          this.dispatch('server/setTrust', trustData.trust);
          this.onTrustChange?.(trustData.trust);
          break;
        }

        case 'chat:ask-question':
          this.dispatch('chat/askQuestion', data);
          break;

        case 'jobs:updated':
          this.dispatch('jobs/updated', data);
          break;

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
    if (this.initialStateDispatched) return;
    if (!this.sessionState) {
      console.error('[Bridge] Cannot dispatch initial state — session:connected was not received or failed to parse');
      return;
    }
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

      // Mark the server as running BEFORE restoring chats so the webview
      // renders the chat UI immediately. Messages will populate into the
      // already-visible interface — much better UX than blocking on
      // "Waiting for server to start" during a multi-second restore.
      this.dispatch('server/statusChanged', 'Running');

      await this.restoreChats();
    } finally {
      this.restoring = false;
      this.flushRestoreQueue();
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
   * All chats returned by the server are shown in the sidebar — the server
   * is the authority on which chats are valid.
   */
  private async restoreChats(): Promise<void> {
    let summaries: ChatSummary[] | undefined = this.sessionState?.chats;

    // Fallback: fetch summaries from REST if session:connected had none.
    // Retries once after a short delay to handle post-refresh network churn.
    if (!summaries?.length) {
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          summaries = await this.api.chats();
          break;
        } catch (err) {
          if (attempt < 2) {
            console.warn('[Bridge] Failed to fetch chat list, retrying in 500ms...', err);
            await new Promise((r) => setTimeout(r, 500));
          } else {
            console.error('[Bridge] Failed to fetch chat list after retries:', err);
            return;
          }
        }
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

    console.log(`[Bridge] Populating sidebar with ${summaries.length} chat(s)`);

    // Register sidebar entries for every chat (no messages dispatched)
    for (const summary of summaries) {
      if (!summary?.id) continue;
      this.upsertChatEntry(summary.id, {
        title: summary.title ?? 'Chat',
        status: summary.status ?? 'idle',
      });
    }

    // Build a priority-ordered list of chats to try loading.
    // Preferred (from previous session) comes first, then most-recent-first.
    const candidates: ChatSummary[] = [];
    const preferred = this.preferredChatId
      ? summaries.find((s) => s.id === this.preferredChatId)
      : null;
    if (preferred) candidates.push(preferred);
    // Add remaining summaries in reverse order (most recent first), skipping preferred.
    for (let i = summaries.length - 1; i >= 0; i--) {
      if (summaries[i].id !== preferred?.id) {
        candidates.push(summaries[i]);
      }
    }

    // Try each candidate until one loads successfully.
    let loaded = false;
    let hadTransientFailures = false;
    for (const candidate of candidates) {
      if (!candidate?.id) continue;
      this.currentChatId = candidate.id;
      const result = await this.loadChatMessages(candidate.id);
      if (result === true) {
        // Clear stale preferred if we had to fall back to a different chat.
        if (preferred && candidate.id !== preferred.id) {
          console.log(`[Bridge] Preferred chat ${this.preferredChatId} no longer exists, fell back to ${candidate.id}`);
          this.preferredChatId = null;
        }
        loaded = true;
        this.restoreRetryCount = 0; // Reset retry counter on success
        break;
      }
      if (result === 'not_found') {
        // Chat is confirmed deleted on the server — remove stale sidebar entry.
        console.warn(`[Bridge] Chat ${candidate.id} no longer exists, removing from sidebar`);
        this.removeChatEntry(candidate.id);
      } else {
        // Transient error (timeout, network, 500) — keep the sidebar entry
        // so the user can retry later. Don't remove valid chats on flaky networks.
        console.warn(`[Bridge] Chat ${candidate.id} failed to load (transient error), keeping sidebar entry`);
        hadTransientFailures = true;
      }
    }

    // If nothing loaded, clear stale preferred and reset current chat so
    // the webview shows a clean welcome screen instead of a ghost entry.
    if (!loaded) {
      this.currentChatId = null;
      this.preferredChatId = null;

      // If we had transient failures (not 404s), schedule a retry — the
      // server is likely temporarily unreachable after a page refresh.
      if (hadTransientFailures && this.restoreRetryCount < WebBridge.MAX_RESTORE_RETRIES) {
        this.restoreRetryCount++;
        const delay = 2_000 * this.restoreRetryCount; // Increasing delay: 2s, 4s, 6s
        console.log(`[Bridge] Scheduling automatic chat restore retry ${this.restoreRetryCount}/${WebBridge.MAX_RESTORE_RETRIES} in ${delay}ms...`);
        setTimeout(() => {
          if (!this.disposed && !this.loadedChatIds.size) {
            this.retryRestoreChats();
          }
        }, delay);
      } else if (hadTransientFailures) {
        console.error(`[Bridge] Giving up after ${this.restoreRetryCount} restore retries. Chats may be available — try refreshing the page.`);
      }
    }

    this.notifyChatListChange();
  }

  /**
   * Lazy-load a single chat's messages from the server and dispatch them
   * to the webview. Skips if the chat was already loaded.
   *
   * Performance: checks the in-memory message cache first to avoid a REST
   * round-trip (e.g. on tab switch or reconnection). Falls back to REST
   * on cache miss, and populates the cache on success.
   *
   * Called automatically on initial connect (for the most recent chat)
   * and on demand when the user switches chats.
   *
   * @returns `true` if the chat was successfully loaded (or was already loaded),
   *          `'not_found'` if the chat is confirmed deleted on the server (404),
   *          `'error'` if loading failed due to a transient issue (timeout, network, 500).
   */
  async loadChatMessages(chatId: string): Promise<boolean | 'not_found' | 'error'> {
    if (this.loadedChatIds.has(chatId)) return true;

    try {
      console.log(`[Bridge] Loading messages for chat ${chatId}`);

      // Try cache first — instant restore without network
      const cached = messageCache.get(this.host, chatId);
      let chat = cached?.chat ?? null;

      if (chat) {
        console.log(`[Bridge] Cache hit for chat ${chatId} (${chat.messages?.length ?? 0} msgs)`);
      } else {
        // Cache miss — fetch from server with retries
        const result = await this.fetchChatWithRetry(chatId);
        if (result === WebBridge.CHAT_NOT_FOUND) return 'not_found';
        if (result === WebBridge.CHAT_FETCH_ERROR) return 'error';
        chat = result;

        // Populate cache for future use
        messageCache.set(this.host, chatId, chat);
      }

      this.loadedChatIds.add(chatId);

      // Clear any partial content the webview may already have from live SSE
      // events (e.g. a running chat that streamed new content before the user
      // clicked on it), or stale content from a previous session (reconnect).
      // This prevents duplicates when we replay the full history.
      // Safe for non-existent chats — the reducer no-ops via an existence guard.
      this.dispatch('chat/cleared', { chatId, messages: true });

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

      // Batch-dispatch all events in a single postMessage → single Redux
      // dispatch → single Immer draft → single React render. This is orders
      // of magnitude faster than dispatching each event individually (which
      // would cause N separate Immer drafts and N React renders).
      this.dispatch('chat/batchContentReceived', events);

      console.log(`[Bridge] Restored ${chat?.messages?.length ?? 0} message(s) for chat ${chatId}`);
      return true;
    } catch (err) {
      console.error(`[Bridge] Failed to load messages for chat ${chatId}:`, err);
      return 'error';
    }
  }

  /** Result of fetchChatWithRetry — discriminates 404 from transient errors. */
  private static readonly CHAT_NOT_FOUND = 'not_found' as const;
  private static readonly CHAT_FETCH_ERROR = 'fetch_error' as const;

  /**
   * Fetch a chat from the REST API with retries and exponential backoff.
   * Does NOT retry on "does not exist" errors (404) — the chat is gone.
   *
   * Returns the chat on success, or a discriminated string indicating
   * whether the failure was a confirmed 404 ('not_found') or a transient
   * error ('fetch_error'). This lets the caller decide whether to remove
   * the sidebar entry (404) or keep it (transient).
   */
  private async fetchChatWithRetry(
    chatId: string,
  ): Promise<import('./types').RemoteChat | 'not_found' | 'fetch_error'> {
    const MAX_ATTEMPTS = 3;
    const RETRY_DELAY_MS = 500;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        return await this.api.getChat(chatId);
      } catch (err: any) {
        // Don't retry on 404 — the chat is definitively gone.
        // Check both the HTTP status code (attached by api.request()) and
        // the error message for robustness.
        if (err?.status === 404 || err?.message?.includes('does not exist')) {
          console.warn(`[Bridge] Chat ${chatId} does not exist on the server`);
          return WebBridge.CHAT_NOT_FOUND;
        }

        if (attempt < MAX_ATTEMPTS) {
          console.warn(`[Bridge] Fetch attempt ${attempt}/${MAX_ATTEMPTS} failed for chat ${chatId}, retrying in ${RETRY_DELAY_MS}ms...`, err);
          await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
        } else {
          console.error(`[Bridge] All ${MAX_ATTEMPTS} fetch attempts failed for chat ${chatId}:`, err);
        }
      }
    }
    return WebBridge.CHAT_FETCH_ERROR;
  }

  /**
   * Replay SSE events that were queued while `restoring` was true.
   * Called in the `finally` block of `dispatchInitialState()` and
   * `syncAfterReconnect()` after `restoring` is set back to false.
   */
  private flushRestoreQueue(): void {
    if (this.restoreQueue.length === 0) return;

    const queued = this.restoreQueue;
    this.restoreQueue = [];
    console.log(`[Bridge] Replaying ${queued.length} queued SSE event(s) from restore window`);

    for (const event of queued) {
      this.handleSSEEvent(event);
    }
  }

  /**
   * Retry chat restoration after a transient failure.
   * Resets the dispatch guard and loaded state, then re-runs `restoreChats()`.
   * Safe to call multiple times — protected by the `restoring` flag.
   */
  private async retryRestoreChats(): Promise<void> {
    if (this.restoring || this.disposed) return;

    console.log('[Bridge] Retrying chat restore...');
    this.restoring = true;
    try {
      this.loadedChatIds.clear();
      await this.restoreChats();
    } catch (err) {
      console.error('[Bridge] Retry of chat restore failed:', err);
    } finally {
      this.restoring = false;
      this.flushRestoreQueue();
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
