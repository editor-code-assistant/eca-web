import { useCallback, useEffect, useRef, useState } from 'react';
import { WebBridge } from '../bridge/transport';
import WebviewApp from '@webview/App';
import './RemotePage.css';

type ConnectionState =
  | { status: 'idle' }
  | { status: 'connecting' }
  | { status: 'connected'; bridge: WebBridge }
  | { status: 'error'; message: string };

const STORAGE_KEY = 'eca-remote-connection';

function loadSavedConnection(): { host: string; token: string } | null {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) return JSON.parse(saved);
  } catch { /* ignore */ }
  return null;
}

function saveConnection(host: string, token: string): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ host, token }));
}

export function RemotePage() {
  const [state, setState] = useState<ConnectionState>({ status: 'idle' });
  const bridgeRef = useRef<WebBridge | null>(null);
  const connectAttempted = useRef(false);

  const doConnect = useCallback(async (host: string, token: string) => {
    setState({ status: 'connecting' });

    const bridge = new WebBridge(host, token);
    bridgeRef.current = bridge;

    try {
      await bridge.connect();
      saveConnection(host, token);
      setState({ status: 'connected', bridge });
    } catch (err: any) {
      bridge.disconnect();
      bridgeRef.current = null;
      setState({ status: 'error', message: err.message || 'Connection failed' });
    }
  }, []);

  // Check URL params for deep link, then fallback to saved connection
  useEffect(() => {
    if (connectAttempted.current) return;
    connectAttempted.current = true;

    const params = new URLSearchParams(window.location.search);
    const host = params.get('host');
    const token = params.get('token');

    if (host && token) {
      window.history.replaceState({}, '', window.location.pathname);
      doConnect(host, token);
      return;
    }

    // Try saved connection
    const saved = loadSavedConnection();
    if (saved) {
      doConnect(saved.host, saved.token);
    }
  }, [doConnect]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      bridgeRef.current?.disconnect();
    };
  }, []);

  if (state.status === 'connected') {
    return <WebviewApp />;
  }

  return <ConnectForm state={state} onConnect={doConnect} />;
}

function ConnectForm({
  state,
  onConnect,
}: {
  state: ConnectionState;
  onConnect: (host: string, token: string) => void;
}) {
  const saved = loadSavedConnection();
  const [host, setHost] = useState(saved?.host || '');
  const [token, setToken] = useState(saved?.token || '');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (host.trim() && token.trim()) {
      onConnect(host.trim(), token.trim());
    }
  };

  const isConnecting = state.status === 'connecting';

  return (
    <div className="connect-page">
      <div className="connect-card">
        <div className="connect-logo">
          <img src="/logo.svg" alt="ECA" />
        </div>
        <h1>ECA Remote</h1>
        <p className="connect-subtitle">Connect to a running ECA session</p>

        <form onSubmit={handleSubmit} className="connect-form">
          <div className="connect-field">
            <label htmlFor="host">Host</label>
            <input
              id="host"
              type="text"
              placeholder="192.168.1.42:7888"
              value={host}
              onChange={(e) => setHost(e.target.value)}
              disabled={isConnecting}
              autoFocus
            />
          </div>

          <div className="connect-field">
            <label htmlFor="token">Token</label>
            <input
              id="token"
              type="password"
              placeholder="Bearer token"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              disabled={isConnecting}
            />
          </div>

          <button type="submit" className="connect-button" disabled={isConnecting || !host.trim() || !token.trim()}>
            {isConnecting ? 'Connecting…' : 'Connect'}
          </button>
        </form>

        {state.status === 'error' && (
          <div className="connect-error">{state.message}</div>
        )}

        <p className="connect-hint">
          Start ECA with <code>remote.enabled: true</code> in your config.
          <br />
          The connection URL is printed to stderr on startup.
        </p>
      </div>
    </div>
  );
}
