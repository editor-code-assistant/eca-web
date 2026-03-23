/**
 * Outbound message handler — routes webview messages to REST API calls.
 *
 * The webview communicates via CustomEvents ('eca-web-send') or the
 * window.__ecaWebTransport.send() interface. This module maps each
 * outbound message type to the appropriate REST call or local action.
 *
 * Design: pure function mapping, no state. The WebBridge provides
 * the API client and dispatch function as dependencies.
 */

import type { EcaRemoteApi } from './api';
import type { UserPromptData } from './types';

/** Callback to send a message to the webview via window.postMessage. */
export type Dispatch = (type: string, data: unknown) => void;

/** Context needed by the outbound handler to process messages. */
export interface OutboundContext {
  api: EcaRemoteApi;
  dispatch: Dispatch;
  /** Returns the current chat ID (for session-wide operations). */
  getCurrentChatId: () => string | null;
  /** Updates the current chat ID (e.g. after sending a prompt). */
  setCurrentChatId: (id: string) => void;
  /** Triggers initial state dispatch (called on webview/ready). */
  dispatchInitialState: () => Promise<void>;
  /** Lazy-load messages for a chat (fetches from server if not yet loaded). */
  loadChatMessages: (chatId: string) => Promise<boolean | 'not_found' | 'error'>;
}

/**
 * Handle a single outbound message from the webview.
 *
 * Each case is deliberately simple — one or two lines that call
 * the API client or dispatch a response. This makes it easy to
 * add new message types or audit the routing logic.
 */
export async function handleOutbound(
  msg: { type: string; data: any },
  ctx: OutboundContext,
): Promise<void> {
  const { type, data } = msg;
  const { api, dispatch } = ctx;

  try {
    switch (type) {
      // --- Lifecycle ---
      case 'webview/ready':
        await ctx.dispatchInitialState();
        break;

      // --- Chat operations ---
      case 'chat/userPrompt':
        await handleUserPrompt(data, ctx);
        break;

      case 'chat/toolCallApprove':
        await api.approveToolCall(data.chatId, data.toolCallId, data.save);
        break;

      case 'chat/toolCallReject':
        await api.rejectToolCall(data.chatId, data.toolCallId);
        break;

      case 'chat/promptStop':
        await api.stopPrompt(data.chatId);
        break;

      case 'chat/delete':
        // No-op in web: closing a tab should not delete the chat from the
        // server cache.  The webview already removes it locally via resetChat.
        break;

      case 'chat/rollback':
        await api.rollbackChat(data.chatId, data.contentId);
        break;

      case 'chat/clearChat':
        await api.clearChat(data.chatId);
        break;

      // --- Config changes (apply to current chat) ---
      case 'chat/selectedModelChanged':
        await withCurrentChat(ctx, (chatId) => api.changeModel(chatId, data.model));
        break;

      case 'chat/selectedAgentChanged':
        await withCurrentChat(ctx, (chatId) => api.changeAgent(chatId, data.agent));
        break;

      case 'chat/selectedVariantChanged':
        await withCurrentChat(ctx, (chatId) => api.changeVariant(chatId, data.variant));
        break;

      // --- Editor operations ---
      case 'editor/openUrl':
        window.open(data.url, '_blank');
        break;

      case 'editor/readInput': {
        const value = window.prompt(data.message);
        dispatch('editor/readInput', { requestId: data.requestId, value });
        break;
      }

      case 'editor/saveFile':
        downloadFile(data.content, data.defaultName);
        break;

      case 'editor/saveClipboardImage':
        // Not supported in web — return null so the webview doesn't hang
        dispatch('editor/saveClipboardImage', { requestId: data.requestId, path: null });
        break;

      case 'editor/toggleSidebar':
        window.dispatchEvent(new CustomEvent('eca-toggle-sidebar'));
        break;

      // --- Query operations (not available via REST — return empty) ---
      case 'chat/queryContext':
        dispatch('chat/queryContext', { chatId: data.chatId, contexts: [] });
        break;

      case 'chat/queryCommands':
        dispatch('chat/queryCommands', { chatId: data.chatId, commands: [] });
        break;

      case 'chat/queryFiles':
        dispatch('chat/queryFiles', { chatId: data.chatId, files: [] });
        break;

      // --- Trust mode ---
      case 'server/setTrust':
        await api.setTrust(data);
        break;

      // --- MCP operations ---
      case 'mcp/startServer':
        await api.mcpStartServer(data.name);
        break;

      case 'mcp/stopServer':
        await api.mcpStopServer(data.name);
        break;

      case 'mcp/connectServer':
        await api.mcpConnectServer(data.name);
        break;

      case 'mcp/logoutServer':
        await api.mcpLogoutServer(data.name);
        break;

      case 'mcp/updateServer':
        // Respond immediately to prevent webviewSendAndGet from hanging
        // (no REST endpoint for updating MCP server config in web context)
        console.log(`[outbound] MCP update not available in web`);
        if (data.requestId) {
          dispatch('editor/readInput', { requestId: data.requestId, value: null });
        }
        break;

      // --- Ignored (no web equivalent) ---
      case 'editor/openFile':
      case 'editor/openGlobalConfig':
      case 'editor/openServerLogs':
      case 'editor/refresh':
        break;

      default:
        console.log(`[outbound] Unhandled message: ${type}`);
    }
  } catch (err) {
    console.error(`[outbound] Error handling ${type}:`, err);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Handle a user prompt: creates a new chat if no chatId is provided.
 *
 * The server has full chat context — there's no need to re-fetch or
 * re-load messages before sending. Doing so would risk dispatching
 * `chat/cleared` on the visible chat (clearing all messages) if the
 * chat wasn't in `loadedChatIds` (e.g. after a reconnect re-sync).
 */
async function handleUserPrompt(data: UserPromptData, ctx: OutboundContext): Promise<void> {
  const chatId = data.chatId || crypto.randomUUID();
  ctx.setCurrentChatId(chatId);

  await ctx.api.sendPrompt(chatId, {
    message: data.prompt,
    model: data.model,
    agent: data.agent,
    variant: data.variant,
    trust: data.trust,
    contexts: data.contexts,
  });
}

/**
 * Run an action against the current chat ID, silently catching errors.
 * Used for config changes (model/agent/variant) which are best-effort.
 */
async function withCurrentChat(
  ctx: OutboundContext,
  action: (chatId: string) => Promise<void>,
): Promise<void> {
  const chatId = ctx.getCurrentChatId();
  if (chatId) {
    await action(chatId).catch(() => {});
  }
}

/**
 * Trigger a file download in the browser.
 */
function downloadFile(content: string, defaultName?: string): void {
  const blob = new Blob([content], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = defaultName || 'export.md';
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}
