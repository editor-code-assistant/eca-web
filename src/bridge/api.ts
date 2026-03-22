/**
 * REST API client for the ECA remote server.
 *
 * Every public method corresponds to one REST endpoint.
 * All methods throw on non-OK responses (except 409 on idempotent
 * operations like stop/approve/reject where the action already happened).
 */

import type {
  ChatSummary,
  HealthResponse,
  RemoteChat,
  SendPromptBody,
  SendPromptResponse,
  SessionResponse,
} from './types';
import type { Protocol } from './utils';
import { localNetworkFetchOptions, resolveBaseUrl } from './utils';

export class EcaRemoteApi {
  private baseUrl: string;
  private password: string;

  constructor(host: string, password: string, protocol?: Protocol) {
    this.baseUrl = resolveBaseUrl(host, protocol);
    this.password = password;
  }

  // ---------------------------------------------------------------------------
  // Core HTTP helpers
  // ---------------------------------------------------------------------------

  /** Build auth + optional JSON content-type headers. */
  private headers(json = false): HeadersInit {
    const h: HeadersInit = { 'Authorization': `Bearer ${this.password}` };
    if (json) h['Content-Type'] = 'application/json';
    return h;
  }

  /**
   * Generic fetch-check-parse helper.
   * - Adds auth headers automatically.
   * - Throws an `Error` when the response status is not OK,
   *   unless `allowStatus` includes that specific code.
   * - Returns `undefined` for 204 No Content or void endpoints.
   */
  private async request<T = void>(
    path: string,
    options: {
      method?: string;
      body?: unknown;
      auth?: boolean;
      /** HTTP status codes that should NOT throw (e.g. 409 for idempotent ops). */
      allowStatus?: number[];
    } = {},
  ): Promise<T> {
    const { method = 'GET', body, auth = true, allowStatus = [] } = options;
    const hasBody = body !== undefined;

    const url = `${this.baseUrl}${path}`;
    const res = await fetch(url, {
      ...localNetworkFetchOptions(url),
      method,
      headers: auth ? this.headers(hasBody) : (hasBody ? { 'Content-Type': 'application/json' } : undefined),
      ...(hasBody ? { body: JSON.stringify(body) } : {}),
    });

    if (!res.ok && !allowStatus.includes(res.status)) {
      // Try to extract a structured error message from the body
      const errBody = await res.json().catch(() => null);
      const message = errBody?.error?.message || `${method} ${path} failed: ${res.status}`;
      throw new Error(message);
    }

    // Return parsed JSON for responses that have a body
    const text = await res.text();
    if (text) return JSON.parse(text) as T;
    return undefined as unknown as T;
  }

  // ---------------------------------------------------------------------------
  // Endpoints
  // ---------------------------------------------------------------------------

  /** Health check — unauthenticated, used to test reachability. */
  async health(): Promise<HealthResponse> {
    return this.request<HealthResponse>('/health', { auth: false });
  }

  /** Get the current session state (workspace, config, models, etc.). */
  async session(): Promise<SessionResponse> {
    return this.request<SessionResponse>('/session');
  }

  /** List all chat summaries. */
  async chats(): Promise<ChatSummary[]> {
    return this.request<ChatSummary[]>('/chats');
  }

  /** Get a single chat with full message history. */
  async getChat(chatId: string): Promise<RemoteChat> {
    return this.request<RemoteChat>(`/chats/${chatId}`);
  }

  /** Send a user prompt to a chat (creates the chat if it doesn't exist). */
  async sendPrompt(chatId: string, body: SendPromptBody): Promise<SendPromptResponse> {
    return this.request<SendPromptResponse>(`/chats/${chatId}/prompt`, {
      method: 'POST',
      body,
    });
  }

  /** Stop an in-progress prompt. Ignores 409 (already stopped). */
  async stopPrompt(chatId: string): Promise<void> {
    return this.request(`/chats/${chatId}/stop`, {
      method: 'POST',
      allowStatus: [409],
    });
  }

  /** Approve a pending tool call. Ignores 409 (already handled). */
  async approveToolCall(chatId: string, toolCallId: string, save?: string): Promise<void> {
    return this.request(`/chats/${chatId}/approve/${toolCallId}`, {
      method: 'POST',
      body: save ? { save } : undefined,
      allowStatus: [409],
    });
  }

  /** Reject a pending tool call. Ignores 409 (already handled). */
  async rejectToolCall(chatId: string, toolCallId: string): Promise<void> {
    return this.request(`/chats/${chatId}/reject/${toolCallId}`, {
      method: 'POST',
      allowStatus: [409],
    });
  }

  /** Roll back a chat to a specific content ID. */
  async rollbackChat(chatId: string, contentId: string): Promise<void> {
    return this.request(`/chats/${chatId}/rollback`, {
      method: 'POST',
      body: { contentId },
    });
  }

  /** Clear all messages in a chat. */
  async clearChat(chatId: string): Promise<void> {
    return this.request(`/chats/${chatId}/clear`, { method: 'POST' });
  }

  /** Delete a chat entirely. */
  async deleteChat(chatId: string): Promise<void> {
    return this.request(`/chats/${chatId}`, { method: 'DELETE' });
  }

  /** Change the model for a chat. */
  async changeModel(chatId: string, model: string): Promise<void> {
    return this.request(`/chats/${chatId}/model`, {
      method: 'POST',
      body: { model },
    });
  }

  /** Change the agent for a chat. */
  async changeAgent(chatId: string, agent: string): Promise<void> {
    return this.request(`/chats/${chatId}/agent`, {
      method: 'POST',
      body: { agent },
    });
  }

  /** Change the reasoning variant for a chat. */
  async changeVariant(chatId: string, variant: string): Promise<void> {
    return this.request(`/chats/${chatId}/variant`, {
      method: 'POST',
      body: { variant },
    });
  }

  // ---------------------------------------------------------------------------
  // Trust
  // ---------------------------------------------------------------------------

  /** Set the trust mode on the server. */
  async setTrust(trust: boolean): Promise<void> {
    return this.request('/trust', {
      method: 'POST',
      body: { trust },
    });
  }

  // ---------------------------------------------------------------------------
  // MCP operations
  // ---------------------------------------------------------------------------

  /** Start an MCP server by name. */
  async mcpStartServer(name: string): Promise<void> {
    return this.request(`/mcp/${encodeURIComponent(name)}/start`, { method: 'POST' });
  }

  /** Stop an MCP server by name. */
  async mcpStopServer(name: string): Promise<void> {
    return this.request(`/mcp/${encodeURIComponent(name)}/stop`, { method: 'POST' });
  }

  /** Connect (reconnect) an MCP server by name. */
  async mcpConnectServer(name: string): Promise<void> {
    return this.request(`/mcp/${encodeURIComponent(name)}/connect`, { method: 'POST' });
  }

  /** Logout an MCP server by name. */
  async mcpLogoutServer(name: string): Promise<void> {
    return this.request(`/mcp/${encodeURIComponent(name)}/logout`, { method: 'POST' });
  }

  // ---------------------------------------------------------------------------
  // SSE
  // ---------------------------------------------------------------------------

  /** The URL for the SSE event stream. */
  sseUrl(): string {
    return `${this.baseUrl}/events`;
  }

  /** The auth password (needed by SSEClient to authenticate the stream). */
  get authPassword(): string {
    return this.password;
  }
}
