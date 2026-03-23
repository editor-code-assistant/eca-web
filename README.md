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

The web app is a thin shell around the **shared webview UI** (`eca-webview/` git submodule) — the same chat UI used in VS Code and IntelliJ. A bridge layer (`src/bridge/`) fakes the editor environment by:

- **Inbound:** SSE events from the server are dispatched as `window.postMessage` calls, matching the message types the editor extensions use.
- **Outbound:** The webview's `webviewSend()` calls are intercepted via `window.__ecaWebTransport` and mapped to REST API calls.

This means the chat UI, Redux store, and all components work identically across editors — only the transport layer differs.

### Authentication

All requests use `Authorization: Bearer <token>` headers — no cookies. SSE is consumed via `fetch()` + `ReadableStream` (not `EventSource`) to support custom auth headers.

## Development setup

```bash
git clone --recurse-submodules https://github.com/editor-code-assistant/eca-web.git
cd eca-web
npm install
npm run dev        # Dev server on http://localhost:8080
```

If you already cloned without `--recurse-submodules`:

```bash
git submodule update --init
```

Other commands:

```bash
npm run build      # Type-check + production build → dist/
npm run preview    # Serve the production build locally
```

### Docker

Run eca-web without Node.js:

```bash
docker run -p 8080:80 ghcr.io/editor-code-assistant/eca-web
```

Then open [http://localhost:8080](http://localhost:8080).

## Connecting to ECA

For full remote configuration options (host, port, password, etc.), see the **[Remote Configuration docs](https://eca.dev/config/remote)**.

### From URL (automatic)

ECA logs a URL like:

```
🔗 https://web.eca.dev?host=192.168.1.42:7888&token=a3f8b2...
```

Click it — the frontend auto-connects, strips the token from the URL, and saves the connection to localStorage.

### Manual

Go to [web.eca.dev](https://web.eca.dev), enter the host IP and password, and hit **Discover & Connect** — it scans ports 7777–7787 and connects to any running ECA sessions automatically.

## License

Apache-2.0
