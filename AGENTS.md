# AGENTS.md — ECA Web

> Architecture and development guide for LLM coding assistants working on this codebase.

## Project Overview

**ECA Web** is a standalone React web app that connects to remote ECA (Editor Code Assistant) server instances. It embeds the `eca-webview` (originally designed for VS Code/IntelliJ) inside a web shell, bridging the webview's `postMessage`-based communication with the server's REST + SSE APIs.

**Key insight:** The webview doesn't know it's running in a browser. It thinks it's inside an editor (VS Code/IntelliJ). The bridge layer (`src/bridge/`) fakes the editor environment by:
1. Receiving SSE events from the server → dispatching them as `window.postMessage` (mimicking what the editor extension would do)
2. Intercepting outbound messages from the webview → translating them into REST API calls

## Architecture

```
┌──────────────────────────────────────────────────────┐
│  Browser                                             │
│                                                      │
│  ┌─────────────┐   ┌─────────────┐                  │
│  │  App Shell   │   │  eca-webview │  (embedded)     │
│  │  (pages/)    │   │  (Redux app) │                 │
│  └──────┬───────┘   └──────┬───────┘                 │
│         │                  │                         │
│         │     window.postMessage / CustomEvent        │
│         │                  │                         │
│  ┌──────┴──────────────────┴───────┐                 │
│  │         Bridge Layer            │                 │
│  │  transport.ts (coordinator)     │                 │
│  │  ├── api.ts (REST client)       │                 │
│  │  ├── sse.ts (event stream)      │                 │
│  │  ├── chat-restore.ts (format)   │                 │
│  │  └── outbound-handler.ts (route)│                 │
│  └──────────────┬──────────────────┘                 │
│                 │                                    │
└─────────────────┼────────────────────────────────────┘
                  │  HTTP / SSE
                  ▼
         ┌────────────────┐
         │  ECA Server     │
         │  (remote)       │
         └────────────────┘
```

## Directory Structure

```
src/
├── main.tsx                    # Entry point — sets up editor='web' globals
├── App.tsx                     # Top-level routing (only 'remote' product for now)
│
├── bridge/                     # 🔑 Core: server communication layer
│   ├── index.ts                # Barrel exports
│   ├── types.ts                # All TypeScript types for the bridge
│   ├── utils.ts                # Shared utilities (protocol resolution, fetch timeout)
│   ├── api.ts                  # REST API client (EcaRemoteApi class)
│   ├── sse.ts                  # SSE stream client with heartbeat detection
│   ├── transport.ts            # WebBridge — coordinator wiring SSE↔REST↔webview
│   ├── chat-restore.ts         # Converts stored messages → webview events
│   ├── outbound-handler.ts     # Routes webview messages → REST API calls
│   └── connection.ts           # Pre-connection health/auth testing
│
├── pages/                      # UI pages
│   ├── RemoteProduct.tsx       # Multi-connection orchestrator
│   ├── RemoteProduct.css
│   ├── RemoteSession.tsx       # Single connection lifecycle (bridge + webview)
│   ├── RemoteSession.css
│   ├── ConnectForm.tsx         # Host/token input form
│   ├── ConnectForm.css
│   └── ConnectionBar.tsx       # Tab bar for switching connections
│
├── components/                 # Shared UI components
│   ├── AppHeader.tsx/css       # Top navigation bar
│   └── AppLayout.css           # Root layout
│
├── storage/                    # Persistence
│   └── connections.ts          # localStorage for connection list & deep-links
│
├── styles/
│   └── web-theme.css           # CSS custom properties for the dark theme
│
└── types/
    └── global.d.ts             # Window interface augmentation

eca-webview/                    # Git submodule — the shared webview UI
  src/
  ├── protocol.ts               # 📋 All message types (ChatContent, ToolCall, etc.)
  ├── pages/chat/               # Chat UI components
  └── redux/                    # Redux store (chat, server, mcp slices)
```

## Key Patterns

### 1. Message Bridge Pattern

The webview communicates via `window.postMessage`. The bridge intercepts these:

**Inbound (Server → Webview):**
```
SSE event → WebBridge.handleSSEEvent() → window.postMessage({ type, data }) → Webview Redux
```

**Outbound (Webview → Server):**
```
Webview → CustomEvent('eca-web-send') or window.__ecaWebTransport.send() → outbound-handler → REST API
```

### 2. Chat Restore Pattern

When connecting, the bridge restores existing chats by converting stored messages (LLM format) to the fine-grained events the webview expects:

```
StoredMessage { role: 'tool_call', content: { id, name, arguments } }
  ↓ chat-restore.ts
ChatContentReceivedParams { type: 'toolCallPrepare', id, name, argumentsText }
```

**Important:** During restore, live SSE `chat:content-received` events are suppressed (`this.restoring` flag) to prevent duplicate messages.

### 3. Connection Lifecycle

```
ConnectForm → testConnection() → RemoteProduct adds entry → RemoteSession mounts
  → WebBridge.connect() → health check → SSE handshake → dispatchInitialState()
  → WebviewApp renders
```

### 4. Multi-Connection Tabs

Each connection is a `ConnectionEntry` with its own `RemoteSession` (keyed by ID). Only the active session renders the webview. Connection state is persisted in localStorage.

## Common Tasks

### Adding a new REST API endpoint

1. Add the response type to `src/bridge/types.ts`
2. Add the method to `src/bridge/api.ts` (use `this.request<T>()`)
3. If it's triggered by the webview, add a case in `src/bridge/outbound-handler.ts`

### Handling a new SSE event type

1. Add the event type to `SSEEventType` in `src/bridge/types.ts`
2. Add payload type if needed
3. Add a case in `WebBridge.handleSSEEvent()` in `src/bridge/transport.ts`
4. Map to the appropriate webview dispatch call

### Adding a new outbound message type

1. Add to `OutboundMessage` union in `src/bridge/types.ts`
2. Add a case in `handleOutbound()` in `src/bridge/outbound-handler.ts`

### Modifying chat restore logic

Edit `src/bridge/chat-restore.ts`. Each stored message role has its own converter function. The `chatToRestoreEvents()` function orchestrates the full restore.

## TypeScript Conventions

- **Types file:** Bridge-layer types live in `src/bridge/types.ts`. Webview protocol types are in `eca-webview/src/protocol.ts`.
- **No `any`:** The api.ts `request<T>()` method returns typed responses. Use the types from `types.ts`.
- **Immutable state:** MCP servers list in transport.ts uses spread operators, not mutation.
- **JSDoc:** Every exported function and class has a JSDoc comment explaining its purpose.

## Important Notes

- The `eca-webview/` directory is an embedded dependency (not a separate npm package). It's aliased as `@webview` in vite.config.ts and tsconfig.json.
- The webview assumes it's running inside an editor. Some operations (open file, clipboard image) are no-ops in the web context — see `outbound-handler.ts`.
- The `editor` localStorage key is set to `'web'` and `data-editor="web"` is set on `<html>` — this controls CSS theme variable selection in the webview.
- SSE heartbeat timeout is 35 seconds. If you see disconnections, check the server's heartbeat interval.
