/**
 * TypeScript types for the bridge layer.
 *
 * These types cover:
 * - REST API request/response shapes
 * - SSE event payloads
 * - Session state managed by WebBridge
 * - Outbound message types (webview → bridge)
 *
 * For webview-internal types (ChatContent, ToolCallDetails, etc.)
 * see `eca-webview/src/protocol.ts`.
 */

import type {
  ChatContext as _ChatContext,
  ChatContentReceivedParams as _ChatContentReceivedParams,
  MCPServerUpdatedParams as _MCPServerUpdatedParams,
  WorkspaceFolder as _WorkspaceFolder,
} from '@webview/protocol';

// Re-export webview types used across the bridge layer,
// so consumers import from one place instead of reaching into @webview.
export type ChatContext = _ChatContext;
export type ChatContentReceivedParams = _ChatContentReceivedParams;
export type MCPServerUpdatedParams = _MCPServerUpdatedParams;
export type WorkspaceFolder = _WorkspaceFolder;

// ---------------------------------------------------------------------------
// REST API response types
// ---------------------------------------------------------------------------

/** GET /api/v1/health */
export interface HealthResponse {
  status: string;
  version: string;
}

/** GET /api/v1/session (partial — fields used by the bridge) */
export interface SessionResponse {
  workspaceFolders?: WorkspaceFolder[];
  models?: ModelInfo[];
  agents?: AgentInfo[];
  mcpServers?: MCPServerUpdatedParams[];
  /** Chat summaries only (no messages) — messages are lazy-loaded per chat. */
  chats?: ChatSummary[];
  welcomeMessage?: string;
  selectModel?: string;
  selectAgent?: string;
  variants?: string[];
  selectedVariant?: string | null;
}

export interface ModelInfo {
  id: string;
  [key: string]: unknown;
}

export interface AgentInfo {
  id: string;
  [key: string]: unknown;
}

/** GET /api/v1/chats — list summary */
export interface ChatSummary {
  id: string;
  title?: string;
  status?: 'idle' | 'running';
  /** Creation timestamp — epoch millis (number) or ISO string. */
  createdAt?: string | number;
  /** Last activity timestamp — epoch millis (number) or ISO string. */
  updatedAt?: string | number;
  /** Present when this chat belongs to a subagent. Subagent chats are excluded from the sidebar. */
  parentChatId?: string;
}

/** GET /api/v1/chats/:id — full chat detail */
export interface RemoteChat {
  id: string;
  title?: string;
  status?: 'idle' | 'running';
  messages?: StoredMessage[];
}

/** POST /api/v1/chats/:id/prompt — request body */
export interface SendPromptBody {
  message: string;
  model?: string;
  agent?: string;
  variant?: string;
  trust?: boolean;
  contexts?: ChatContext[];
}

/** POST /api/v1/chats/:id/prompt — response */
export interface SendPromptResponse {
  chatId: string;
  model?: string;
}

// ---------------------------------------------------------------------------
// Stored message types (LLM conversation format from the server)
// ---------------------------------------------------------------------------

export type StoredMessageRole =
  | 'user'
  | 'assistant'
  | 'tool_call'
  | 'tool_call_output'
  | 'reason'
  | 'server_tool_use'
  | 'server_tool_result';

export interface StoredMessage {
  role: StoredMessageRole;
  content: unknown;
  contentId?: string;
}

export interface StoredTextContent {
  type: 'text';
  text: string;
}

export interface StoredToolCallContent {
  id: string;
  name?: string;
  fullName?: string;
  arguments?: string | Record<string, unknown>;
  origin?: string;
  summary?: string;
  details?: unknown;
  server?: string;
}

export interface StoredToolCallOutputContent {
  id: string;
  name?: string;
  fullName?: string;
  output?: {
    error?: boolean;
    contents?: Array<{ type: string; text: string }>;
  };
  totalTimeMs?: number;
  details?: unknown;
  summary?: string;
  server?: string;
}

export interface StoredReasonContent {
  id: string;
  text?: string;
  totalTimeMs?: number;
}

// ---------------------------------------------------------------------------
// SSE event types
// ---------------------------------------------------------------------------

/** Discriminated union of all known SSE event types from the server. */
export type SSEEventType =
  | 'session:connected'
  | 'session:message'
  | 'session:disconnecting'
  | 'chat:content-received'
  | 'chat:cleared'
  | 'chat:deleted'
  | 'chat:status-changed'
  | 'config:updated'
  | 'tool:server-updated'
  | 'trust:updated';

export interface SSESessionConnectedPayload {
  workspaceFolders?: WorkspaceFolder[];
  models?: ModelInfo[];
  agents?: AgentInfo[];
  mcpServers?: MCPServerUpdatedParams[];
  /** Chat summaries only (no messages) — messages are lazy-loaded per chat. */
  chats?: ChatSummary[];
  welcomeMessage?: string;
  selectModel?: string;
  selectAgent?: string;
  variants?: string[];
  selectedVariant?: string | null;
  trust?: boolean;
}

export interface SSETrustUpdatedPayload {
  trust: boolean;
}

export interface SSEChatStatusPayload {
  chatId: string;
  status: 'idle' | 'running';
}

export interface SSESessionMessagePayload {
  type: 'info' | 'warn' | 'error';
  message: string;
}

// ---------------------------------------------------------------------------
// Session state (held by WebBridge after connection)
// ---------------------------------------------------------------------------

export interface SessionState {
  workspaceFolders?: WorkspaceFolder[];
  models?: ModelInfo[];
  agents?: AgentInfo[];
  mcpServers?: MCPServerUpdatedParams[];
  /** Chat summaries (no messages) from the initial session:connected event. */
  chats?: ChatSummary[];
  config?: SessionConfig;
  trust?: boolean;
}

export interface SessionConfig {
  chat: {
    models: string[];
    agents: string[];
    welcomeMessage: string;
    selectModel?: string;
    selectAgent?: string;
    variants: string[];
    selectedVariant: string | null;
  };
}

// ---------------------------------------------------------------------------
// Outbound messages (webview → bridge → REST)
// ---------------------------------------------------------------------------

/**
 * Union of all outbound message types the webview can send.
 * Used by handleOutbound() for type-safe routing.
 */
export type OutboundMessage =
  | { type: 'webview/ready'; data: undefined }
  | { type: 'chat/userPrompt'; data: UserPromptData }
  | { type: 'chat/toolCallApprove'; data: { chatId: string; toolCallId: string; save?: string } }
  | { type: 'chat/toolCallReject'; data: { chatId: string; toolCallId: string } }
  | { type: 'chat/promptStop'; data: { chatId: string } }
  | { type: 'chat/promptSteer'; data: { chatId: string; message: string } }
  | { type: 'chat/delete'; data: { chatId: string } }
  | { type: 'chat/rollback'; data: { chatId: string; contentId: string } }
  | { type: 'chat/clearChat'; data: { chatId: string } }
  | { type: 'chat/addFlag'; data: { chatId: string; contentId: string } }
  | { type: 'chat/removeFlag'; data: { chatId: string; contentId: string } }
  | { type: 'chat/fork'; data: { chatId: string; contentId: string } }
  | { type: 'chat/selectedModelChanged'; data: { model: string } }
  | { type: 'chat/selectedAgentChanged'; data: { agent: string } }
  | { type: 'chat/selectedVariantChanged'; data: { variant: string } }
  | { type: 'editor/openUrl'; data: { url: string } }
  | { type: 'editor/openFile'; data: unknown }
  | { type: 'editor/openGlobalConfig'; data: unknown }
  | { type: 'editor/openServerLogs'; data: unknown }
  | { type: 'editor/refresh'; data: unknown }
  | { type: 'editor/readInput'; data: { requestId: string; message: string } }
  | { type: 'editor/saveFile'; data: { content: string; defaultName?: string } }
  | { type: 'editor/saveClipboardImage'; data: { requestId: string } }
  | { type: 'chat/queryContext'; data: { chatId: string; query: string } }
  | { type: 'chat/queryCommands'; data: { chatId: string; query: string } }
  | { type: 'chat/queryFiles'; data: { chatId: string; query: string } }
  | { type: 'mcp/startServer'; data: { name: string } }
  | { type: 'mcp/stopServer'; data: { name: string } }
  | { type: 'mcp/connectServer'; data: { name: string } }
  | { type: 'mcp/logoutServer'; data: { name: string } }
  | { type: 'mcp/updateServer'; data: { requestId?: string } }
  | { type: 'server/setTrust'; data: boolean };

export interface UserPromptData {
  chatId?: string;
  prompt: string;
  model?: string;
  agent?: string;
  variant?: string;
  trust?: boolean;
  contexts?: ChatContext[];
}

// ---------------------------------------------------------------------------
// Chat sidebar types (shell-level chat list for the sidebar)
// ---------------------------------------------------------------------------

/** Lightweight chat entry exposed to the React shell for the sidebar. */
export interface ChatEntry {
  id: string;
  title: string;
  status: 'idle' | 'running';
}

/** Callback signature for chat list change notifications. */
export type ChatListChangeCallback = (chats: ChatEntry[], selectedChatId: string | null) => void;

/** Callback signature for trust state change notifications. */
export type TrustChangeCallback = (trust: boolean) => void;

// ---------------------------------------------------------------------------
// Reconnection types
// ---------------------------------------------------------------------------

/** State emitted by the bridge during auto-reconnection attempts. */
export interface ReconnectionState {
  status: 'reconnecting' | 'reconnected' | 'failed';
  /** Current attempt number (1-based). */
  attempt: number;
  /** Milliseconds until the next retry (only while status === 'reconnecting'). */
  nextRetryMs?: number;
  /** Callback to manually trigger a reconnection attempt (available when status is 'reconnecting' or 'failed'). */
  retryNow?: () => void;
}

/** Callback signature for reconnection state changes. */
export type ReconnectionCallback = (state: ReconnectionState) => void;

// ---------------------------------------------------------------------------
// Webview dispatch types (bridge → webview via postMessage)
// ---------------------------------------------------------------------------

/**
 * Known dispatch message types sent to the webview via window.postMessage.
 * Matches the reducers in eca-webview/src/redux/slices/.
 */
export type DispatchType =
  | 'server/statusChanged'
  | 'server/setWorkspaceFolders'
  | 'server/setTrust'
  | 'config/updated'
  | 'tool/serversUpdated'
  | 'chat/contentReceived'
  | 'chat/cleared'
  | 'chat/deleted'
  | 'chat/opened'
  | 'chat/queryContext'
  | 'chat/queryCommands'
  | 'chat/queryFiles'
  | 'editor/readInput'
  | 'editor/saveClipboardImage';
