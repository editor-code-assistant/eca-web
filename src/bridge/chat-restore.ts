/**
 * Chat restore — converts stored server messages to webview events.
 *
 * The ECA server stores messages in LLM conversation format
 * (user/assistant/tool_call/tool_call_output/reason).
 *
 * The webview expects fine-grained contentReceived events
 * (text, toolCallPrepare, toolCalled, reasonStarted, etc.).
 *
 * This module bridges the two formats during chat restoration.
 */

import type { ChatContentReceivedParams } from '@webview/protocol';
import type {
  RemoteChat,
  StoredMessage,
  StoredReasonContent,
  StoredTextContent,
  StoredToolCallContent,
  StoredToolCallOutputContent,
} from './types';

/** A contentReceived event ready to be dispatched to the webview. */
export type RestoreEvent = ChatContentReceivedParams;

/**
 * Convert a single stored message into one or more webview events.
 *
 * Returns an empty array for unknown/internal roles (server_tool_use, etc.)
 * so the caller can safely iterate without null checks.
 */
export function storedMessageToEvents(chatId: string, msg: StoredMessage): RestoreEvent[] {
  switch (msg.role) {
    case 'user':
      return convertUserMessage(chatId, msg);
    case 'assistant':
      return convertAssistantMessage(chatId, msg);
    case 'tool_call':
      return convertToolCall(chatId, msg);
    case 'tool_call_output':
      return convertToolCallOutput(chatId, msg);
    case 'reason':
      return convertReason(chatId, msg);
    case 'server_tool_use':
    case 'server_tool_result':
      // Internal LLM format — no webview representation
      return [];
    default:
      console.log(`[chat-restore] Unknown message role: ${msg.role}`);
      return [];
  }
}

/**
 * Restore a full chat into a sequence of dispatch-ready events.
 *
 * This includes:
 * 1. All stored messages → contentReceived events
 * 2. Chat title → metadata event
 * 3. Running status → progress event (if still running)
 */
export function chatToRestoreEvents(chat: RemoteChat): RestoreEvent[] {
  const events: RestoreEvent[] = [];

  if (!chat?.id) return events;

  // Replay stored messages
  if (chat.messages?.length) {
    for (const msg of chat.messages) {
      events.push(...storedMessageToEvents(chat.id, msg));
    }
  }

  // Title metadata
  if (chat.title) {
    events.push({
      chatId: chat.id,
      role: 'system',
      content: { type: 'metadata', title: chat.title },
    });
  }

  // Running indicator
  if (chat.status === 'running') {
    events.push({
      chatId: chat.id,
      role: 'system',
      content: { type: 'progress', state: 'running', text: 'Running...' },
    });
  }

  return events;
}

// ---------------------------------------------------------------------------
// Converters (one per stored message role)
// ---------------------------------------------------------------------------

function convertUserMessage(chatId: string, msg: StoredMessage): RestoreEvent[] {
  const contents = normalizeContentArray(msg.content);
  const events: RestoreEvent[] = [];

  for (const item of contents) {
    const textItem = item as StoredTextContent;
    if (textItem.type === 'text') {
      events.push({
        chatId,
        role: 'user',
        content: {
          type: 'text',
          text: textItem.text,
          ...(msg.contentId ? { contentId: msg.contentId } : {}),
        },
      });
    }
  }
  return events;
}

function convertAssistantMessage(chatId: string, msg: StoredMessage): RestoreEvent[] {
  const contents = normalizeContentArray(msg.content);
  const events: RestoreEvent[] = [];

  for (const item of contents) {
    const textItem = item as StoredTextContent;
    if (textItem.type === 'text') {
      events.push({
        chatId,
        role: 'assistant',
        content: { type: 'text', text: textItem.text },
      });
    }
  }
  return events;
}

function convertToolCall(chatId: string, msg: StoredMessage): RestoreEvent[] {
  const tc = msg.content as StoredToolCallContent;
  return [{
    chatId,
    role: 'assistant',
    content: {
      type: 'toolCallPrepare',
      id: tc.id,
      name: tc.name || tc.fullName || 'unknown',
      argumentsText: typeof tc.arguments === 'string'
        ? tc.arguments
        : JSON.stringify(tc.arguments, null, 2),
      origin: (tc.origin as 'native' | 'mcp') || 'native',
      manualApproval: false,
      summary: tc.summary,
      details: tc.details,
      server: tc.server,
    } as any, // Details shape varies — safe cast
  }];
}

function convertToolCallOutput(chatId: string, msg: StoredMessage): RestoreEvent[] {
  const tco = msg.content as StoredToolCallOutputContent;
  return [{
    chatId,
    role: 'assistant',
    content: {
      type: 'toolCalled',
      id: tco.id,
      name: tco.name || tco.fullName || 'unknown',
      error: tco.output?.error || false,
      outputs: tco.output?.contents || [],
      totalTimeMs: tco.totalTimeMs,
      details: tco.details,
      summary: tco.summary,
      server: tco.server,
    } as any, // Details shape varies — safe cast
  }];
}

function convertReason(chatId: string, msg: StoredMessage): RestoreEvent[] {
  const r = msg.content as StoredReasonContent;
  const events: RestoreEvent[] = [];

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
    content: { type: 'reasonFinished', id: r.id, totalTimeMs: r.totalTimeMs || 0 },
  });

  return events;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Normalize content to always be an array (some roles store a single object). */
function normalizeContentArray(content: unknown): unknown[] {
  return Array.isArray(content) ? content : [content];
}
