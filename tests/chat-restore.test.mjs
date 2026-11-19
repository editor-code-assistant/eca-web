// Run with: node --test tests/chat-restore.test.mjs
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('../', import.meta.url));
let vite;
let restore;
let WebBridge;
let messageCache;
let chatSlice;
let messages;
let state;
let originalWindow;

before(async () => {
  // Use the project's existing TS transformation; no test-only build or listener.
  vite = await createServer({
    root,
    configFile: false,
    server: { middlewareMode: true, watch: null, hmr: false },
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  restore = await vite.ssrLoadModule('/src/bridge/chat-restore.ts');
  ({ WebBridge } = await vite.ssrLoadModule('/src/bridge/transport.ts'));
  ({ messageCache } = await vite.ssrLoadModule('/src/bridge/message-cache.ts'));
  ({ chatSlice } = await vite.ssrLoadModule('/eca-webview/src/redux/slices/chat.ts'));
});

after(async () => { await vite?.close(); });

beforeEach(() => {
  originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  messages = [];
  state = chatSlice.getInitialState();
  messageCache.clear();
  const actions = {
    'chat/batchContentReceived': 'batchContentReceived',
    'chat/contentReceived': 'addContentReceived',
    'chat/askQuestion': 'setPendingQuestion',
    'chat/cleared': 'cleared',
    'chat/opened': 'chatOpened',
    'chat/selectChat': 'selectChat',
  };
  globalThis.window = {
    // Apply the real reducers synchronously; this is not a browser event loop.
    postMessage(message) {
      messages.push(message);
      const action = actions[message.type];
      if (action) state = chatSlice.reducer(state, chatSlice.actions[action](message.data));
    },
  };
});

afterEach(() => {
  messageCache.clear();
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else delete globalThis.window;
});

const host = 'synthetic.example:1234';

function pending(overrides = {}) {
  return {
    id: 'tool-1', name: 'ask_user', requestId: 'request-1',
    arguments: {
      question: 'Which option?',
      options: [{ label: 'First', description: 'First choice' }, { label: 'Second' }],
      allowFreeform: false,
    },
    ...overrides,
  };
}

function snapshot(overrides = {}) {
  return {
    id: 'chat-1', title: 'Synthetic chat', status: 'running', messages: [],
    pendingToolCalls: [pending()],
    ...overrides,
  };
}

function event(name, data) {
  return { event: name, data: JSON.stringify(data) };
}

function bridgeFor(chat) {
  const bridge = new WebBridge(host, 'synthetic-test-token', 'http');
  bridge.api.getChat = async () => chat;
  bridge.handleSessionConnected(event('session:connected', { chats: [{ id: chat.id }] }));
  return bridge;
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('pending questions retain the original identity, options and freeform permission', () => {
  assert.deepEqual(restore.chatToPendingQuestions(snapshot()), [{
    chatId: 'chat-1', toolCallId: 'tool-1', requestId: 'request-1',
    question: 'Which option?',
    options: [{ label: 'First', description: 'First choice' }, { label: 'Second' }],
    allowFreeform: false,
  }]);
});

test('restoration matches ask_user option normalization and defaults freeform to true', () => {
  const [question] = restore.chatToPendingQuestions(snapshot({
    pendingToolCalls: [pending({ arguments: {
      question: 'Choose or type',
      options: JSON.stringify(['One', '', null, 3, {}, { label: 'Two', description: 'Details' }]),
    } })],
  }));
  assert.deepEqual(question.options, [{ label: 'One' }, { label: 'Two', description: 'Details' }]);
  assert.equal(question.allowFreeform, true);
  const [freeformOnly] = restore.chatToPendingQuestions(snapshot({
    pendingToolCalls: [pending({ arguments: { question: 'Type an answer' } })],
  }));
  assert.deepEqual(freeformOnly.options, []);
  const [malformedOptions] = restore.chatToPendingQuestions(snapshot({
    pendingToolCalls: [pending({ arguments: { question: 'Still answerable', options: '{invalid' } })],
  }));
  assert.deepEqual(malformedOptions.options, []);
});

test('history, approvals and incomplete pending calls do not invent interactive questions', () => {
  const chat = snapshot({
    messages: [{ role: 'tool_call', content: { id: 'old', name: 'ask_user', arguments: { question: 'Old?' } } }],
    pendingToolCalls: [
      { id: 'approval', name: 'shell_command', arguments: { command: 'pwd' }, manualApproval: true },
      pending({ requestId: undefined }),
      pending({ requestId: '' }),
      pending({ arguments: { question: '  ' } }),
      pending({ arguments: null }),
    ],
  });
  assert.deepEqual(restore.chatToPendingQuestions(chat), []);
  assert.deepEqual(restore.chatToPendingQuestions({ id: 'older-server' }), []);
  assert.equal(restore.chatToRestoreEvents(chat)[0].content.type, 'toolCallPrepare');
});

test('late opening creates the chat before restoring its answerable question', async () => {
  const bridge = bridgeFor(snapshot());
  await bridge.dispatchInitialState();
  assert.equal(state.chats['chat-1'].pendingQuestion.requestId, 'request-1');
  assert.equal(state.chats['chat-1'].pendingQuestion.options.length, 2);
  assert.ok(messages.findIndex(m => m.type === 'chat/batchContentReceived')
    < messages.findIndex(m => m.type === 'chat/askQuestion'));
  let submission;
  bridge.api.answerQuestion = async (...args) => { submission = args; };
  bridge.routeOutbound({
    type: 'chat/answerQuestion',
    data: { requestId: state.chats['chat-1'].pendingQuestion.requestId, answer: 'First', cancelled: false },
  });
  assert.deepEqual(submission, ['request-1', 'First', false]);
});

test('a new connection cannot hide a question behind cached pre-question history', async () => {
  messageCache.set(host, 'chat-1', snapshot({ pendingToolCalls: [] }));
  const bridge = bridgeFor(snapshot());
  let fetches = 0;
  bridge.api.getChat = async () => { fetches++; return snapshot(); };
  await bridge.dispatchInitialState();
  assert.equal(fetches, 1);
  assert.equal(state.chats['chat-1'].pendingQuestion.requestId, 'request-1');
});

test('reconnect refreshes pending state even when history was already loaded and cached', async () => {
  const bridge = bridgeFor(snapshot({ pendingToolCalls: [] }));
  await bridge.dispatchInitialState();
  assert.equal(state.chats['chat-1'].pendingQuestion, undefined);
  bridge.api.getChat = async () => snapshot();
  bridge.handleSessionConnected(event('session:connected', { chats: [{ id: 'chat-1' }] }));
  await bridge.syncAfterReconnect();
  assert.equal(state.chats['chat-1'].pendingQuestion.requestId, 'request-1');
});

test('cached questions absent from a fresh connection snapshot are not resurrected', async () => {
  messageCache.set(host, 'chat-1', snapshot());
  const bridge = bridgeFor(snapshot({ status: 'idle', pendingToolCalls: [] }));
  await bridge.dispatchInitialState();
  assert.equal(state.chats['chat-1'].pendingQuestion, undefined);
  assert.equal(messages.some(m => m.type === 'chat/askQuestion'), false);
});

test('questions predating webview readiness are recovered from the fresh snapshot', async () => {
  const bridge = bridgeFor(snapshot());
  bridge.handleSSEEvent(event('chat:ask-question', restore.chatToPendingQuestions(snapshot())[0]));
  // RootWrapper resets chats before sending webview/ready.
  state = chatSlice.reducer(state, chatSlice.actions.resetChats());
  await bridge.dispatchInitialState();
  assert.equal(state.chats['chat-1'].pendingQuestion.requestId, 'request-1');
});

test('pre-ready text already in the snapshot is not appended twice', async () => {
  const chat = snapshot({
    status: 'idle', pendingToolCalls: [],
    messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Hello' }] }],
  });
  const bridge = bridgeFor(chat);
  bridge.handleSSEEvent(event('chat:content-received', {
    chatId: chat.id, role: 'assistant', content: { type: 'text', text: 'Hello' },
  }));
  state = chatSlice.reducer(state, chatSlice.actions.resetChats());
  await bridge.dispatchInitialState();
  assert.equal(state.chats[chat.id].messages
    .filter(message => message.type === 'text' && message.role === 'assistant')
    .map(message => message.value).join(''), 'Hello');
});

test('question events during initial restoration follow chat creation', async () => {
  const bridge = bridgeFor(snapshot({ pendingToolCalls: [] }));
  const response = deferred();
  bridge.api.getChat = () => response.promise;
  const loading = bridge.dispatchInitialState();
  bridge.handleSSEEvent(event('chat:ask-question', {
    chatId: 'chat-1', requestId: 'during-restore', question: 'Live?', options: [],
  }));
  assert.equal(messages.some(m => m.type === 'chat/askQuestion'), false);
  response.resolve(snapshot({ pendingToolCalls: [] }));
  await loading;
  assert.equal(state.chats['chat-1'].pendingQuestion.requestId, 'during-restore');
});

test('snapshot and live delivery of the same request retain one pending question', async () => {
  const chat = snapshot();
  const [question] = restore.chatToPendingQuestions(chat);
  const bridge = bridgeFor(chat);
  const response = deferred();
  bridge.api.getChat = () => response.promise;
  const loading = bridge.dispatchInitialState();
  bridge.handleSSEEvent(event('chat:ask-question', question));
  response.resolve(chat);
  await loading;
  assert.deepEqual(state.chats[chat.id].pendingQuestion, question);
});

test('question events during lazy chat loading are not dropped by the reducer', async () => {
  const bridge = bridgeFor(snapshot({ pendingToolCalls: [] }));
  await bridge.dispatchInitialState();
  const response = deferred();
  bridge.api.getChat = () => response.promise;
  const loading = bridge.loadChatMessages('chat-2');
  bridge.handleSSEEvent(event('chat:ask-question', {
    chatId: 'chat-2', requestId: 'during-load', question: 'Live?', options: [],
  }));
  response.resolve(snapshot({ id: 'chat-2', pendingToolCalls: [] }));
  await loading;
  assert.equal(state.chats['chat-2'].pendingQuestion?.requestId, 'during-load');
});

test('the already-connected live question path still works', async () => {
  const bridge = bridgeFor(snapshot({ pendingToolCalls: [] }));
  await bridge.dispatchInitialState();
  bridge.handleSSEEvent(event('chat:ask-question', {
    chatId: 'chat-1', requestId: 'live', question: 'Live?', options: [{ label: 'Yes' }],
  }));
  assert.equal(state.chats['chat-1'].pendingQuestion.requestId, 'live');
  assert.equal(messageCache.has(host, 'chat-1'), false);
});

test('a matching tool completion clears a question answered by another client', async () => {
  const bridge = bridgeFor(snapshot({ pendingToolCalls: [] }));
  await bridge.dispatchInitialState();
  bridge.handleSSEEvent(event('chat:ask-question', {
    chatId: 'chat-1', toolCallId: 'tool-1', requestId: 'live', question: 'Live?', options: [],
  }));
  bridge.handleSSEEvent(event('chat:content-received', {
    chatId: 'chat-1', role: 'system',
    content: {
      type: 'toolCalled', origin: 'native', id: 'other-tool', name: 'read_file',
      arguments: [], error: false, outputs: [], totalTimeMs: 1,
    },
  }));
  assert.equal(state.chats['chat-1'].pendingQuestion.requestId, 'live');
  bridge.handleSSEEvent(event('chat:content-received', {
    chatId: 'chat-1', role: 'system',
    content: {
      type: 'toolCalled', origin: 'native', id: 'tool-1', name: 'ask_user',
      arguments: [], error: false, outputs: [], totalTimeMs: 1,
    },
  }));
  assert.equal(state.chats['chat-1'].pendingQuestion, undefined);
});

test('a disconnected bridge does not publish a delayed snapshot into another session', async () => {
  const bridge = bridgeFor(snapshot());
  const response = deferred();
  bridge.api.getChat = () => response.promise;
  const loading = bridge.dispatchInitialState();
  bridge.disconnect();
  const count = messages.length;
  response.resolve(snapshot());
  await loading;
  assert.equal(messages.length, count);
});

const idle = (overrides = {}) => snapshot({ status: 'idle', pendingToolCalls: [], title: undefined, ...overrides });
const contents = (chat) => restore.chatToRestoreEvents(chat).map(e => e.content);

test('a rejected call restores rejected, with its summary and reason', async () => {
  const call = {
    id: 'tc-1', name: 'shell_command', fullName: 'eca__shell_command', server: 'eca', origin: 'native',
    arguments: { command: 'echo hi' }, summary: '$ echo hi',
  };
  const chat = idle({ messages: [
    { role: 'tool_call', content: call },
    { role: 'tool_call_output', content: {
      ...call, rejectionReason: 'user-choice-deny',
      output: { error: true, contents: [{ type: 'text', text: 'This tool call did NOT run' }] },
    } },
  ] });
  const events = contents(chat);
  assert.deepEqual(events.map(c => c.type), ['toolCallPrepare', 'toolCallRun', 'toolCallRejected']);
  assert.equal(events[2].reason, 'userChoiceDeny');
  await bridgeFor(chat).dispatchInitialState();
  const tool = state.chats['chat-1'].messages.find(m => m.type === 'toolCall');
  assert.equal(tool.status, 'rejected');
  assert.equal(tool.summary, '$ echo hi');
});

test('context a module added for the model is not shown, as live', () => {
  const [user, , called] = contents(idle({ messages: [
    { role: 'user', contentId: 'u1', content: [
      { type: 'text', text: 'hi' }, { type: 'text', text: 'notes', module: 'acme/memory' }] },
    { role: 'tool_call', content: { id: 'tc', name: 'read_file', arguments: {} } },
    { role: 'tool_call_output', content: { id: 'tc', name: 'read_file', error: false, output: { error: false, contents: [
      { type: 'text', text: 'file' }, { type: 'text', text: 'hook context', module: 'eca/hooks' }] } } },
  ] }));
  assert.deepEqual(user, { type: 'text', text: 'hi', contentId: 'u1' });
  assert.deepEqual(called.outputs, [{ type: 'text', text: 'file' }]);
});

test('flags, compaction markers and system texts restore as ECA replays them', () => {
  const events = restore.chatToRestoreEvents(idle({ messages: [
    { role: 'flag', contentId: 'f1', content: { text: 'checkpoint' } },
    { role: 'compact_marker', content: { 'auto?': true } },
    { role: 'compact_marker', content: { label: 'Memory saved' } },
    { role: 'compact_marker', content: {} },
    { role: 'system', content: [{ type: 'text', text: 'Note' }] },
  ] })).map(e => [e.role, e.content]);
  assert.deepEqual(events, [
    ['system', { type: 'flag', text: 'checkpoint', contentId: 'f1' }],
    ['system', { type: 'text', text: '── Chat auto-compacted ──' }],
    ['system', { type: 'text', text: '── Memory saved ──' }],
    ['system', { type: 'text', text: '── Chat compacted ──' }],
    ['system', { type: 'text', text: 'Note' }],
  ]);
});

test('consecutive reasons restore as one reasoning block', () => {
  const reason = (id, text, totalTimeMs) => ({ role: 'reason', content: { id, text, totalTimeMs } });
  assert.deepEqual(contents(idle({ messages: [
    reason('r1', null, 1000), reason('r2', 'Plan', 500), reason('r3', ' ', 0), reason('r4', 'Act', 250),
    { role: 'assistant', content: [{ type: 'text', text: 'Hi' }] },
  ] })), [
    { type: 'reasonStarted', id: 'r1' },
    { type: 'reasonText', id: 'r1', text: 'Plan\n\nAct' },
    { type: 'reasonFinished', id: 'r1', totalTimeMs: 1750 },
    { type: 'text', text: 'Hi' },
  ]);
});

test('a search the provider ran restores as a web_search call', async () => {
  await bridgeFor(idle({ messages: [
    { role: 'server_tool_use', content: { id: 's1', name: 'web_search' } },
    { role: 'server_tool_result', content: { toolUseId: 's1' } },
  ] })).dispatchInitialState();
  const tool = state.chats['chat-1'].messages.find(m => m.type === 'toolCall');
  assert.equal(tool.name, 'web_search');
  assert.equal(tool.status, 'succeeded');
});

test('a restored chat shows its own model, agent and variant', async () => {
  await bridgeFor(idle({ model: 'mock/m2', agent: 'plan', variant: 'high' })).dispatchInitialState();
  const update = messages.find(m => m.type === 'config/updated' && m.data.chatId === 'chat-1');
  assert.deepEqual(update.data.chat, { selectModel: 'mock/m2', selectAgent: 'plan', selectVariant: 'high' });
  assert.ok(messages.findIndex(m => m.type === 'chat/batchContentReceived') < messages.indexOf(update),
    'after the chat exists: the reducer ignores unknown chats');
  state = chatSlice.reducer(state, chatSlice.actions.applyConfigToChat(update.data));
  assert.equal(state.chats['chat-1'].selectedModel, 'mock/m2');
  assert.equal(state.chats['chat-1'].selectedAgent, 'plan');
  assert.equal(state.chats['chat-1'].selectedVariant, 'high');
});

test('selecting a chat the webview already has from live events shows it', async () => {
  const bridge = bridgeFor(idle());
  await bridge.dispatchInitialState();
  // A fork, or another client's chat, reaches the webview as live events first.
  bridge.handleSSEEvent(event('chat:opened', { chatId: 'chat-2', title: 'Synthetic chat (2)' }));
  assert.equal(state.selectedChat, 'chat-1');
  bridge.api.getChat = async () => idle({
    id: 'chat-2', messages: [{ role: 'user', content: [{ type: 'text', text: 'Forked' }] }],
  });
  await bridge.selectChat('chat-2');
  assert.equal(state.selectedChat, 'chat-2');
  assert.equal(state.chats['chat-2'].messages.find(m => m.type === 'text').value, 'Forked');
});

test('a chat that loads after the user picked another one does not take the selection', async () => {
  const bridge = bridgeFor(idle());
  await bridge.dispatchInitialState();
  bridge.handleSSEEvent(event('chat:opened', { chatId: 'chat-2', title: 'Synthetic chat (2)' }));
  const response = deferred();
  bridge.api.getChat = () => response.promise;
  const slow = bridge.selectChat('chat-2');
  await bridge.selectChat('chat-1');
  response.resolve(idle({ id: 'chat-2' }));
  await slow;
  assert.equal(state.selectedChat, 'chat-1');
  assert.equal(bridge.getSelectedChatId(), 'chat-1');
});

test('removing a steer message reaches the server', () => {
  const bridge = bridgeFor(idle());
  let removed;
  bridge.api.removeSteer = async (chatId) => { removed = chatId; };
  bridge.routeOutbound({ type: 'chat/promptSteerRemove', data: { chatId: 'chat-1' } });
  assert.equal(removed, 'chat-1');
});

test('an action the server answers with an error tells the user why', async () => {
  const bridge = bridgeFor(idle());
  const reported = [];
  bridge.onActionErrored((message) => reported.push(message));
  const refused = (message, status, code) => async () => { throw Object.assign(new Error(message), { status, code }); };
  bridge.api.mcpStartServer = refused('Method mcp/startServer not found', 404, 'method_not_found');
  bridge.api.deleteChat = refused('Chat chat-9 does not exist', 404, 'chat_not_found');
  bridge.api.mcpStopServer = async () => { throw new Error('Failed to fetch'); };
  bridge.routeOutbound({ type: 'mcp/startServer', data: { name: 'github' } });
  bridge.routeOutbound({ type: 'chat/delete', data: { chatId: 'chat-9' } });
  bridge.routeOutbound({ type: 'mcp/stopServer', data: { name: 'github' } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(reported, [
    "This ECA doesn't offer mcp/startServer: the ECA module serving it is disabled.",
    'chat/delete failed: Chat chat-9 does not exist',
  ], 'no answer from the server (network) is the reconnection banner\'s job');
});
