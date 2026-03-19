# eca-web

Web frontend for [ECA](https://github.com/editor-code-assistant/eca) — observe and control chat sessions from a browser via the ECA remote server.

Hosted at **[web.eca.dev](https://web.eca.dev)** and deployed automatically via GitHub Pages.

## How it works

```
┌──────────────┐   REST + SSE    ┌─────────────────┐   stdio JSON-RPC    ┌────────┐
│  web.eca.dev │ ◄─────────────► │  ECA process    │ ◄────────────────►  │ Editor │
│  (browser)   │   HTTP over LAN │  (embedded HTTP)│                     │        │
└──────────────┘                 └─────────────────┘                     └────────┘
```

1. ECA starts with `remote.enabled: true` and prints a URL to stderr.
2. Open the URL — it loads `web.eca.dev` with connection params in the query string.
3. The frontend connects to the ECA process via REST (commands) and SSE (live updates).
4. Both the editor and the web UI can send prompts, approve tool calls, and control chat — first response wins.

## Project structure

```
eca-web/
├── src/                    # Web shell — connection UI + bridge layer
│   ├── App.tsx             # Router: / → /remote
│   ├── main.tsx            # Entry point
│   ├── bridge/
│   │   ├── api.ts          # REST client for ECA remote server
│   │   ├── sse.ts          # SSE client (fetch + ReadableStream, not EventSource)
│   │   └── transport.ts    # WebBridge: maps SSE events ↔ webview postMessage protocol
│   ├── pages/
│   │   └── RemotePage.tsx  # Connection form + renders webview app on success
│   └── styles/
│       └── web-theme.css   # Dark theme CSS variables
├── eca-webview/            # Shared webview UI (git submodule)
│   └── src/                # Chat UI, Redux store, components — shared with VS Code / IntelliJ
├── public/
│   ├── 404.html            # GitHub Pages SPA redirect
│   └── CNAME               # web.eca.dev
└── .github/
    └── workflows/
        └── deploy.yml      # Build + deploy to GitHub Pages
```

The `eca-webview/` directory is a **git submodule** containing the shared webview UI used by the VS Code extension, IntelliJ plugin, and this web app. The Vite alias `@webview` points to `eca-webview/src`.

## Setup

```bash
git clone --recurse-submodules https://github.com/editor-code-assistant/eca-web.git
cd eca-web
npm install
```

If you already cloned without `--recurse-submodules`:

```bash
git submodule update --init
```

## Development

```bash
npm run dev        # Start dev server on http://localhost:5180
npm run build      # Type-check + production build → dist/
npm run preview    # Serve the production build locally
```

## Connecting to ECA

### From URL (automatic)

ECA logs a URL like:

```
🔗 https://web.eca.dev?host=192.168.1.42:7888&token=a3f8b2...
```

Click it — the frontend auto-connects, strips the token from the URL, and saves the connection to `localStorage`.

### Manual

Go to [web.eca.dev](https://web.eca.dev) and enter the host (`ip:port`) and token in the connection form.

### ECA config

```json
{
  "remote": {
    "enabled": true,
    "host": "myserver.example.com",
    "port": 7888,
    "password": "my-secret"
  }
}
```

| Field      | Default              | Description                                       |
|------------|----------------------|---------------------------------------------------|
| `enabled`  | `false`              | Enable the embedded HTTP server                   |
| `host`     | auto-detected LAN IP | Host in the logged URL (LAN IP, domain, tunnel)   |
| `port`     | random free port     | Port the HTTP server listens on                   |
| `password` | auto-generated token | Auth token; auto-generated and logged if unset    |

## Architecture

The web app is a thin shell around the **shared webview UI** (`eca-webview`). The bridge layer (`src/bridge/`) translates between two protocols:

- **Inbound** (server → browser): SSE events are parsed and dispatched as `window.postMessage` calls, matching the same message types the VS Code / IntelliJ extensions use.
- **Outbound** (browser → server): The webview's `webviewSend()` calls are intercepted via `window.__ecaWebTransport` and mapped to REST API calls.

This means the chat UI, Redux store, and all components work identically across VS Code, IntelliJ, and the web — only the transport layer differs.

### Authentication

All requests use `Authorization: Bearer <token>` headers. No cookies — avoids `Secure`/`SameSite` issues with non-localhost connections. SSE is consumed via `fetch()` + `ReadableStream` (not `EventSource`) to support custom headers.

## License

Apache-2.0
