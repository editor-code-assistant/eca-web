import { EcaRemoteApi } from './api';
import { SSEClient, SSEEvent } from './sse';

interface SessionState {
  workspaceFolders?: any[];
  models?: any[];
  agents?: any[];
  mcpServers?: any[];
  chats?: any[];
  config?: any;
}

/**
 * Bridge between the eca-webview's postMessage-based communication
 * and the ECA remote server's REST + SSE APIs.
 *
 * Inbound (SSE → webview): SSE events dispatched as window.postMessage
 * Outbound (webview → REST): CustomEvent 'eca-web-send' mapped to REST calls
 */
export class WebBridge {
  private api: EcaRemoteApi;
  private sse: SSEClient | null = null;
  private sessionState: SessionState | null = null;
  private connected = false;
  private currentChatId: string | null = null;
  private outboundListener: ((e: Event) => void) | null = null;
  private mcpServers: any[] = [];
  private restoring = false;

  constructor(host: string, token: string) {
    this.api = new EcaRemoteApi(host, token);
  }

  async connect(): Promise<void> {
    // Verify connectivity
    await this.api.health();

    // Connect SSE — session:connected will deliver initial state
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('SSE connection timeout')), 15000);

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

    // Register outbound message handler
    this.registerOutboundHandler();

    // Register on window for webviewSend 'web' case
    window.__ecaWebTransport = {
      send: (msg: { type: string; data: any }) => this.handleOutbound(msg),
    };
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

  /**
   * Called when webview sends 'webview/ready' — dispatch stored initial state.
   */
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

      // Restore chats — prefer session:connected data, fall back to REST
      let chats = this.sessionState.chats;
      if (chats && chats.length > 0) {
        console.log(`[Bridge] Restoring ${chats.length} chat(s) from session:connected`);
        await this.restoreChats(chats);
      } else {
        // Fallback: fetch from REST API
        try {
          const chatSummaries = await this.api.chats();
          console.log(`[Bridge] Fetched ${chatSummaries?.length ?? 0} chat(s) from REST API`);
          if (chatSummaries && chatSummaries.length > 0) {
            await this.restoreChatsFromSummaries(chatSummaries);
          }
        } catch (err) {
          console.error('[Bridge] Failed to fetch chat list:', err);
        }
      }
    } finally {
      this.restoring = false;
    }
  }

  /**
   * Restore chats from full chat objects (e.g. from session:connected).
   * Messages are in LLM conversation format; we transform them into the
   * fine-grained event format the webview reducer expects.
   */
  private async restoreChats(chats: any[]): Promise<void> {
    for (const chat of chats) {
      try {
        if (!chat?.id) continue;

        this.currentChatId = chat.id;

        // Replay stored messages as webview events
        if (chat.messages && chat.messages.length > 0) {
          console.log(`[Bridge] Restoring chat ${chat.id}: ${chat.messages.length} message(s)`);
          for (const msg of chat.messages) {
            const events = this.storedMessageToEvents(chat.id, msg);
            for (const event of events) {
              this.dispatch('chat/contentReceived', event);
            }
          }
        }

        // Restore chat title
        if (chat.title) {
          this.dispatch('chat/contentReceived', {
            chatId: chat.id,
            role: 'system',
            content: { type: 'metadata', title: chat.title },
          });
        }

        // If the chat is running, show progress indicator
        if (chat.status === 'running') {
          this.dispatch('chat/contentReceived', {
            chatId: chat.id,
            role: 'system',
            content: { type: 'progress', state: 'running', text: 'Running...' },
          });
        }
      } catch (err) {
        console.error(`[Bridge] Failed to restore chat ${chat.id}:`, err);
      }
    }
  }

  /**
   * Fallback: restore chats by fetching full details from REST API.
   */
  private async restoreChatsFromSummaries(summaries: any[]): Promise<void> {
    const fullChats: any[] = [];
    for (const summary of summaries) {
      try {
        const chat = await this.api.getChat(summary.id);
        if (chat) fullChats.push(chat);
      } catch (err) {
        console.error(`[Bridge] Failed to fetch chat ${summary.id}:`, err);
      }
    }
    if (fullChats.length > 0) {
      await this.restoreChats(fullChats);
    }
  }

  /**
   * Transform a stored server message (LLM conversation format) into
   * webview contentReceived event(s) (fine-grained event format).
   *
   * Stored roles:
   *   user/assistant → content is an array of items [{type, text}, ...]
   *   tool_call      → content is a single object {id, name, arguments, ...}
   *   tool_call_output → content is a single object {id, output, error, ...}
   *   reason         → content is a single object {id, text, totalTimeMs}
   *   server_tool_use/server_tool_result → internal LLM format, skipped
   */
  private storedMessageToEvents(chatId: string, msg: any): any[] {
    const events: any[] = [];

    switch (msg.role) {
      case 'user': {
        const contents = Array.isArray(msg.content) ? msg.content : [msg.content];
        for (const item of contents) {
          if (item.type === 'text') {
            events.push({
              chatId,
              role: 'user',
              content: {
                type: 'text',
                text: item.text,
                ...(msg.contentId ? { contentId: msg.contentId } : {}),
              },
            });
          }
        }
        break;
      }

      case 'assistant': {
        const contents = Array.isArray(msg.content) ? msg.content : [msg.content];
        for (const item of contents) {
          if (item.type === 'text') {
            events.push({
              chatId,
              role: 'assistant',
              content: { type: 'text', text: item.text },
            });
          }
        }
        break;
      }

      case 'tool_call': {
        const tc = msg.content;
        events.push({
          chatId,
          role: 'assistant',
          content: {
            type: 'toolCallPrepare',
            id: tc.id,
            name: tc.name || tc.fullName,
            argumentsText: typeof tc.arguments === 'string'
              ? tc.arguments
              : JSON.stringify(tc.arguments, null, 2),
            origin: tc.origin || 'native',
            manualApproval: false,
            summary: tc.summary,
            details: tc.details,
            server: tc.server,
          },
        });
        break;
      }

      case 'tool_call_output': {
        const tco = msg.content;
        events.push({
          chatId,
          role: 'assistant',
          content: {
            type: 'toolCalled',
            id: tco.id,
            name: tco.name || tco.fullName,
            error: tco.output?.error || false,
            outputs: tco.output?.contents || [],
            totalTimeMs: tco.totalTimeMs,
            details: tco.details,
            summary: tco.summary,
            server: tco.server,
          },
        });
        break;
      }

      case 'reason': {
        const r = msg.content;
        events.push({
          chatId,
          role: 'assistant',
          content: { type: 'reasonStarted', id: r.id },
        });
        if (r.text) {
          events.push({
            chatId,
            role: 'assistant',
            content: { type: 'reasonText', id: r.id, text: r.text },
          });
        }
        events.push({
          chatId,
          role: 'assistant',
          content: { type: 'reasonFinished', id: r.id, totalTimeMs: r.totalTimeMs },
        });
        break;
      }

      // Server tool use/result are internal to the LLM conversation
      // and don't have a direct webview representation
      case 'server_tool_use':
      case 'server_tool_result':
        break;

      default:
        console.log(`[Bridge] Unknown message role during restore: ${msg.role}`);
    }

    return events;
  }

  // --- SSE Event Handling ---

  private handleSessionConnected(event: SSEEvent): void {
    try {
      const data = JSON.parse(event.data);
      this.sessionState = {
        workspaceFolders: data.workspaceFolders,
        models: data.models,
        agents: data.agents,
        mcpServers: data.mcpServers,
        chats: data.chats,
        config: {
          chat: {
            models: (data.models || []).map((m: any) => m.id || m),
            agents: (data.agents || []).map((a: any) => a.id || a),
            welcomeMessage: data.welcomeMessage || 'Welcome to ECA Web',
            variants: data.variants || [],
            selectedVariant: data.selectedVariant || null,
          },
        },
      };
    } catch (err) {
      console.error('[Bridge] Failed to parse session:connected', err);
    }
  }

  private handleSSEEvent(event: SSEEvent): void {
    // During initial chat restore, skip live chat content events to prevent
    // duplicates. The REST-fetched chat state already includes all messages
    // up to the fetch point; any SSE events for the same content would be
    // redundant. Events arriving after restore completes are processed normally.
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
          // Another client deleted this chat — remove from webview state
          this.dispatch('chat/deleted', data.chatId);
          break;
        case 'chat:status-changed':
          // Map server status transitions to webview progress events
          if (data.status === 'idle') {
            this.dispatch('chat/contentReceived', {
              chatId: data.chatId,
              role: 'system',
              content: { type: 'progress', state: 'finished' },
            });
          } else if (data.status === 'running') {
            this.dispatch('chat/contentReceived', {
              chatId: data.chatId,
              role: 'system',
              content: { type: 'progress', state: 'running', text: 'Running...' },
            });
          }
          break;
        case 'config:updated':
          this.dispatch('config/updated', data);
          break;
        case 'tool:server-updated': {
          // Upsert into local list and dispatch the full array
          const idx = this.mcpServers.findIndex((s: any) => s.name === data.name);
          if (idx >= 0) {
            this.mcpServers[idx] = data;
          } else {
            this.mcpServers.push(data);
          }
          this.dispatch('tool/serversUpdated', [...this.mcpServers]);
          break;
        }
        case 'session:message':
          console.log(`[ECA ${data.type}]`, data.message);
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

  // --- Outbound Message Handling (webview → REST) ---

  private registerOutboundHandler(): void {
    this.outboundListener = (e: Event) => {
      const msg = (e as CustomEvent).detail;
      if (msg) this.handleOutbound(msg);
    };
    window.addEventListener('eca-web-send', this.outboundListener);
  }

  private async handleOutbound(msg: { type: string; data: any }): Promise<void> {
    const { type, data } = msg;

    try {
      switch (type) {
        case 'webview/ready':
          await this.dispatchInitialState();
          break;

        case 'chat/userPrompt':
          await this.handleUserPrompt(data);
          break;

        case 'chat/toolCallApprove':
          await this.api.approveToolCall(data.chatId, data.toolCallId, data.save);
          break;

        case 'chat/toolCallReject':
          await this.api.rejectToolCall(data.chatId, data.toolCallId);
          break;

        case 'chat/promptStop':
          await this.api.stopPrompt(data.chatId);
          break;

        case 'chat/delete':
          await this.api.deleteChat(data.chatId);
          break;

        case 'chat/rollback':
          await this.api.rollbackChat(data.chatId, data.contentId);
          break;

        case 'chat/clearChat':
          await this.api.clearChat(data.chatId);
          break;

        case 'chat/selectedModelChanged': {
          const chatId = this.currentChatId || this.getAnyChatId();
          if (chatId) {
            await this.api.changeModel(chatId, data.model).catch(() => {});
          }
          break;
        }

        case 'chat/selectedAgentChanged': {
          const chatId = this.currentChatId || this.getAnyChatId();
          if (chatId) {
            await this.api.changeAgent(chatId, data.agent).catch(() => {});
          }
          break;
        }

        case 'chat/selectedVariantChanged': {
          const chatId = this.currentChatId || this.getAnyChatId();
          if (chatId) {
            await this.api.changeVariant(chatId, data.variant).catch(() => {});
          }
          break;
        }

        case 'editor/openUrl':
          window.open(data.url, '_blank');
          break;

        case 'editor/openFile':
          // Not applicable in web — ignore
          break;

        case 'editor/openGlobalConfig':
        case 'editor/openServerLogs':
        case 'editor/refresh':
          // Not applicable in web
          break;

        case 'editor/readInput': {
          const value = window.prompt(data.message);
          this.dispatch('editor/readInput', { requestId: data.requestId, value });
          break;
        }

        case 'editor/saveFile':
          this.handleSaveFile(data);
          break;

        case 'editor/saveClipboardImage':
          // Not supported in web for now — return null
          this.dispatch('editor/saveClipboardImage', { requestId: data.requestId, path: null });
          break;

        case 'chat/queryContext':
          // Not available via REST — return empty
          this.dispatch('chat/queryContext', { chatId: data.chatId, contexts: [] });
          break;

        case 'chat/queryCommands':
          this.dispatch('chat/queryCommands', { chatId: data.chatId, commands: [] });
          break;

        case 'chat/queryFiles':
          this.dispatch('chat/queryFiles', { chatId: data.chatId, files: [] });
          break;

        case 'mcp/startServer':
        case 'mcp/stopServer':
        case 'mcp/connectServer':
        case 'mcp/logoutServer':
          // MCP management not available via REST in v1
          console.log(`[Bridge] MCP operation not available in web: ${type}`);
          break;

        case 'mcp/updateServer':
          // MCP update not available via REST in v1 — respond immediately
          // to prevent webviewSendAndGet from hanging for 30s
          console.log(`[Bridge] MCP update not available in web`);
          if (data.requestId) {
            this.dispatch('editor/readInput', { requestId: data.requestId, value: null });
          }
          break;

        default:
          console.log(`[Bridge] Unhandled outbound message: ${type}`);
      }
    } catch (err) {
      console.error(`[Bridge] Error handling ${type}:`, err);
    }
  }

  private async handleUserPrompt(data: any): Promise<void> {
    const chatId = data.chatId || crypto.randomUUID();
    this.currentChatId = chatId;

    await this.api.sendPrompt(chatId, {
      message: data.prompt,
      model: data.model,
      agent: data.agent,
      variant: data.variant,
      trust: data.trust,
      contexts: data.contexts,
    });
  }

  private handleSaveFile(data: any): void {
    const blob = new Blob([data.content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = data.defaultName || 'export.md';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  /**
   * Get any known chat ID for session-wide operations.
   * Falls back to the currentChatId set during restore.
   */
  private getAnyChatId(): string | null {
    return this.currentChatId;
  }

  /** Dispatch a message to the webview via window.postMessage */
  private dispatch(type: string, data: any): void {
    window.postMessage({ type, data }, '*');
  }
}
