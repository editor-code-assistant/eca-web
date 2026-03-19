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

    // Restore existing chats from the server
    if (this.sessionState.chats && this.sessionState.chats.length > 0) {
      await this.restoreChats(this.sessionState.chats);
    }
  }

  /**
   * Fetch full chat details and replay messages to restore chat history.
   */
  private async restoreChats(chatSummaries: any[]): Promise<void> {
    for (const summary of chatSummaries) {
      try {
        const chat = await this.api.getChat(summary.id);
        if (!chat || !chat.messages) continue;

        // Track the most recent chat for model/agent changes
        this.currentChatId = chat.id;

        // Replay each message as a content-received event
        for (const msg of chat.messages) {
          this.dispatch('chat/contentReceived', {
            chatId: chat.id,
            role: msg.role,
            content: msg.content,
          });
        }

        // If the chat has a status, dispatch it
        if (chat.status === 'running') {
          this.dispatch('chat/contentReceived', {
            chatId: chat.id,
            role: 'system',
            content: { type: 'progress', state: 'running', text: 'Running...' },
          });
        }
      } catch (err) {
        console.error(`[Bridge] Failed to restore chat ${summary.id}:`, err);
      }
    }
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
   * Falls back to the first chat from the session state.
   */
  private getAnyChatId(): string | null {
    if (this.sessionState?.chats && this.sessionState.chats.length > 0) {
      return this.sessionState.chats[0].id;
    }
    return null;
  }

  /** Dispatch a message to the webview via window.postMessage */
  private dispatch(type: string, data: any): void {
    window.postMessage({ type, data }, '*');
  }
}
