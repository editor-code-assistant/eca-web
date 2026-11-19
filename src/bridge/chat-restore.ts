/**
 * Chat restore — converts stored server messages to webview events.
 *
 * The ECA server stores messages in LLM conversation format
 * (user/assistant/tool_call/tool_call_output/reason/flag/...).
 *
 * The webview expects fine-grained contentReceived events
 * (text, toolCallPrepare, toolCalled, reasonStarted, etc.).
 *
 * This module bridges the two formats during chat restoration, following
 * what ECA itself sends editors when they reopen a chat (`chat/open`, see
 * ECA's `eca.features.chat.replay`), so a restored chat looks as it did live.
 */

import type { ChatContentReceivedParams } from '@webview/protocol';
import type {
  AskQuestionData,
  RemoteChat,
  StoredCompactMarkerContent,
  StoredFlagContent,
  StoredMessage,
  StoredReasonContent,
  StoredServerToolResultContent,
  StoredServerToolUseContent,
  StoredTextContent,
  StoredToolCallContent,
  StoredToolCallOutputContent,
} from './types';

/** A contentReceived event ready to be dispatched to the webview. */
export type RestoreEvent = ChatContentReceivedParams;

/**
 * Convert a single stored message into one or more webview events.
 *
 * Returns an empty array for roles with no webview representation
 * (e.g. generated images: the webview has no image content), so the
 * caller can safely iterate without null checks.
 */
export function storedMessageToEvents(chatId: string, msg: StoredMessage): RestoreEvent[] {
  switch (msg.role) {
    case 'user':
    case 'system':
    case 'assistant':
      return convertTextMessage(chatId, msg.role, msg);
    case 'tool_call':
      return convertToolCall(chatId, msg);
    case 'tool_call_output':
      return convertToolCallOutput(chatId, msg);
    case 'reason':
      return convertReason(chatId, msg);
    case 'server_tool_use':
      return convertServerToolUse(chatId, msg);
    case 'server_tool_result':
      return convertServerToolResult(chatId, msg);
    case 'compact_marker':
      return convertCompactMarker(chatId, msg);
    case 'flag':
      return convertFlag(chatId, msg);
    case 'image_generation_call':
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
 * 1. All stored messages → contentReceived events (consecutive reasons
 *    merged into one reasoning block, as ECA groups them live)
 * 2. Chat title → metadata event
 * 3. Running status → progress event (if still running)
 */
export function chatToRestoreEvents(chat: RemoteChat): RestoreEvent[] {
  const events: RestoreEvent[] = [];

  if (!chat?.id) return events;

  // Replay stored messages
  if (chat.messages?.length) {
    for (const msg of mergeAdjacentReasons(chat.messages)) {
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

/**
 * Restore actionable ask_user calls from the current snapshot, not history.
 * Dispatch these through chat/askQuestion after the chat's content is restored.
 * Older servers and calls still awaiting approval may have no requestId.
 */
export function chatToPendingQuestions(chat: RemoteChat): AskQuestionData[] {
  if (!chat?.id) return [];

  return (chat.pendingToolCalls ?? []).flatMap((call) => {
    if (call.name !== 'ask_user' || !call.requestId?.trim()) return [];
    const args = call.arguments;
    if (!args || typeof args.question !== 'string' || !args.question.trim()) return [];

    // Match ask_user's normalization: options may be strings, objects, or
    // a JSON-encoded array. Invalid options are ignored, not rendered as buttons.
    let rawOptions = args.options;
    if (typeof rawOptions === 'string') {
      try {
        rawOptions = JSON.parse(rawOptions);
      } catch {
        rawOptions = [];
      }
    }
    const options: AskQuestionData['options'] = [];
    if (Array.isArray(rawOptions)) {
      for (const option of rawOptions) {
        const value = typeof option === 'string' ? { label: option } : option;
        if (!isRecord(value) || typeof value.label !== 'string' || !value.label.trim()) continue;
        options.push({
          label: value.label,
          ...(typeof value.description === 'string' && value.description.trim()
            ? { description: value.description }
            : {}),
        });
      }
    }

    return [{
      chatId: chat.id,
      toolCallId: call.id,
      requestId: call.requestId,
      question: args.question,
      options,
      allowFreeform: args.allowFreeform === undefined ? true : Boolean(args.allowFreeform),
    }];
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Converters (one per stored message role)
// ---------------------------------------------------------------------------

/**
 * A user, system or assistant message: its texts in one event, without the
 * context modules added for the model only (never shown, live or restored).
 */
function convertTextMessage(
  chatId: string,
  role: 'user' | 'system' | 'assistant',
  msg: StoredMessage,
): RestoreEvent[] {
  const texts = normalizeContentArray(msg.content)
    .filter((item): item is StoredTextContent => isTextItem(item) && !isModuleContext(item))
    .map((item) => item.text);
  if (texts.length === 0) return [];
  return [{
    chatId,
    role,
    content: {
      type: 'text',
      text: texts.join('\n'),
      ...(msg.contentId ? { contentId: msg.contentId } : {}),
    },
  }];
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

/**
 * A call that ran restores as called; one that didn't (`rejectionReason`,
 * e.g. the user rejected it) as run then rejected, with that reason.
 */
function convertToolCallOutput(chatId: string, msg: StoredMessage): RestoreEvent[] {
  const tco = msg.content as StoredToolCallOutputContent;
  const name = tco.name || tco.fullName || 'unknown';

  if (tco.rejectionReason) {
    const call = {
      id: tco.id,
      name,
      server: tco.server,
      origin: (tco.origin as 'native' | 'mcp') || 'native',
      arguments: tco.arguments ?? {},
      summary: tco.summary,
      details: tco.details,
    };
    // Casts: the webview's types list `arguments` and have no `reason`,
    // though ECA sends an argument map and the reason (as live).
    return [
      {
        chatId,
        role: 'assistant',
        content: { type: 'toolCallRun', ...call, manualApproval: false } as any,
      },
      {
        chatId,
        role: 'assistant',
        content: { type: 'toolCallRejected', ...call, reason: camelCase(tco.rejectionReason) } as any,
      },
    ];
  }

  return [{
    chatId,
    role: 'assistant',
    content: {
      type: 'toolCalled',
      id: tco.id,
      name,
      error: tco.error ?? tco.output?.error ?? false,
      // Text outputs only: no module context (for the model only), and no
      // images, which the webview has no content for.
      outputs: (tco.output?.contents || []).filter((c) => !isModuleContext(c) && c?.type !== 'image'),
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

/**
 * A tool the LLM provider ran itself, e.g. its web search. Cast: the
 * webview's `ToolCallOrigin` type lacks the `'server'` origin ECA sends.
 */
function convertServerToolUse(chatId: string, msg: StoredMessage): RestoreEvent[] {
  const s = msg.content as StoredServerToolUseContent;
  return [{
    chatId,
    role: 'assistant',
    content: {
      type: 'toolCallPrepare',
      id: s.id,
      name: s.name || 'web_search',
      argumentsText: '',
      origin: 'server',
      server: 'llm',
      manualApproval: false,
    } as any,
  }];
}

function convertServerToolResult(chatId: string, msg: StoredMessage): RestoreEvent[] {
  const { toolUseId: id } = msg.content as StoredServerToolResultContent;
  const call = { id, name: 'web_search', origin: 'server', server: 'llm', arguments: {} };
  return [
    { chatId, role: 'assistant', content: { type: 'toolCallRun', ...call, manualApproval: false } as any },
    { chatId, role: 'assistant', content: { type: 'toolCallRunning', ...call } as any },
    { chatId, role: 'assistant', content: { type: 'toolCalled', ...call, error: false, outputs: [] } as any },
  ];
}

function convertCompactMarker(chatId: string, msg: StoredMessage): RestoreEvent[] {
  const m = (msg.content ?? {}) as StoredCompactMarkerContent;
  const label = typeof m.label === 'string' ? m.label.trim() : '';
  const text = label
    ? `── ${label} ──`
    : m['auto?'] ? '── Chat auto-compacted ──' : '── Chat compacted ──';
  return [{ chatId, role: 'system', content: { type: 'text', text } }];
}

function convertFlag(chatId: string, msg: StoredMessage): RestoreEvent[] {
  const f = msg.content as StoredFlagContent;
  if (!msg.contentId) return [];
  return [{ chatId, role: 'system', content: { type: 'flag', text: f?.text ?? '', contentId: msg.contentId } }];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Collapses each run of consecutive reason messages into one, keeping the
 * first id, joining the non-blank texts with a blank line and summing the
 * times, as ECA groups reasoning live.
 */
function mergeAdjacentReasons(messages: StoredMessage[]): StoredMessage[] {
  const merged: StoredMessage[] = [];
  let run: StoredMessage[] = [];
  const flush = () => {
    if (run.length === 1) {
      merged.push(run[0]);
    } else if (run.length > 1) {
      const contents = run.map((m) => m.content as StoredReasonContent);
      const texts = contents.map((c) => c.text).filter((t): t is string => typeof t === 'string' && t.trim() !== '');
      const times = contents.map((c) => c.totalTimeMs).filter((t): t is number => typeof t === 'number');
      merged.push({
        ...run[0],
        content: {
          id: contents[0].id,
          text: texts.length ? texts.join('\n\n') : undefined,
          totalTimeMs: times.length ? times.reduce((a, b) => a + b, 0) : undefined,
        },
      });
    }
    run = [];
  };
  for (const msg of messages) {
    if (msg.role === 'reason') {
      run.push(msg);
    } else {
      flush();
      merged.push(msg);
    }
  }
  flush();
  return merged;
}

function isTextItem(item: unknown): item is StoredTextContent {
  return isRecord(item) && item.type === 'text' && typeof item.text === 'string';
}

/** Context a module added for the model only (a text with its module id). */
function isModuleContext(item: unknown): boolean {
  return isRecord(item) && item.module != null && item.type === 'text';
}

/** `user-choice-deny` → `userChoiceDeny`, as the protocol names reasons. */
function camelCase(value: string): string {
  return value.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

/** Normalize content to always be an array (some roles store a single object). */
function normalizeContentArray(content: unknown): unknown[] {
  return Array.isArray(content) ? content : [content];
}
