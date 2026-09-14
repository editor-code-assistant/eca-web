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
