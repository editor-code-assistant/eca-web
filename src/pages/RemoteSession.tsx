import { Component, useCallback, useEffect, useRef, useState } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { getMixedContentErrorHint } from '../bridge/connection';
import { WebBridge } from '../bridge/transport';
import type { ReconnectionState } from '../bridge/types';
import type { Protocol } from '../bridge/utils';
import WebviewApp from '@webview/App';
import './RemoteSession.css';

/** Error boundary to catch crashes in RemoteSession / WebviewApp. */
class SessionErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[SessionErrorBoundary]', error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{
          padding: '24px', color: '#f44', fontFamily: 'monospace',
          fontSize: '13px', background: '#12121e', flex: 1, overflow: 'auto',
        }}>
          <h3 style={{ color: '#ff6', margin: '0 0 12px' }}>Session crashed</h3>
          <div style={{ marginBottom: '8px' }}><b>{this.state.error.name}:</b> {this.state.error.message}</div>
          <pre style={{ whiteSpace: 'pre-wrap', color: '#888', fontSize: '11px' }}>
            {this.state.error.stack}
          </pre>
          <button
            onClick={() => this.setState({ error: null })}
            style={{
              marginTop: '16px', padding: '8px 16px', background: '#22223a',
              color: '#e0e4ea', border: '1px solid #2a2a3e', borderRadius: '4px', cursor: 'pointer',
            }}
          >
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

export type SessionStatus = 'connecting' | 'connected' | 'reconnecting' | 'error';

interface RemoteSessionProps {
  host: string;
  password: string;
  protocol?: Protocol;
  /** ID of the last viewed chat — used to restore the previous chat on reconnect. */
  lastChatId?: string;
  onStatusChange: (status: SessionStatus, error?: string) => void;
  /** Called when the bridge instance changes (connected or disconnected). */
  onBridgeChange?: (bridge: WebBridge | null) => void;
}

export function RemoteSession({ host, password, protocol, lastChatId, onStatusChange, onBridgeChange }: RemoteSessionProps) {
  const [state, setState] = useState<
    | { status: 'connecting' }
    | { status: 'connected' }
    | { status: 'error'; message: string }
  >({ status: 'connecting' });

  /** Reconnection overlay state — shown on top of the mounted webview. */
  const [reconnection, setReconnection] = useState<ReconnectionState | null>(null);

  const bridgeRef = useRef<WebBridge | null>(null);
  const mountedRef = useRef(true);
  const lastChatIdRef = useRef(lastChatId);
  lastChatIdRef.current = lastChatId;
  const onStatusChangeRef = useRef(onStatusChange);
  const onBridgeChangeRef = useRef(onBridgeChange);
  onStatusChangeRef.current = onStatusChange;
  onBridgeChangeRef.current = onBridgeChange;

  const connect = useCallback(async () => {
    setState({ status: 'connecting' });
    setReconnection(null);
    onStatusChangeRef.current('connecting');

    // Disconnect any existing bridge
    bridgeRef.current?.disconnect();

    const bridge = new WebBridge(host, password, protocol, lastChatIdRef.current);
    bridgeRef.current = bridge;

    // Subscribe to reconnection events
    bridge.onReconnection((rs) => {
      if (!mountedRef.current) return;
      if (rs.status === 'reconnecting') {
        setReconnection(rs);
        onStatusChangeRef.current('reconnecting');
      } else if (rs.status === 'reconnected') {
        // Keep the banner visible briefly so the user sees success
        setReconnection({ ...rs, status: 'reconnected' });
        onStatusChangeRef.current('connected');
        setTimeout(() => {
          if (mountedRef.current) setReconnection(null);
        }, 1500);
      } else if (rs.status === 'failed') {
        setReconnection(rs);
        onStatusChangeRef.current('reconnecting');
      }
    });

    try {
      await bridge.connect();
      if (!mountedRef.current || !bridge.isConnected()) {
        bridge.disconnect();
        return;
      }
      setState({ status: 'connected' });
      onStatusChangeRef.current('connected');
      onBridgeChangeRef.current?.(bridge);
    } catch (err: any) {
      bridge.disconnect();
      if (!mountedRef.current) return;
      bridgeRef.current = null;
      let message = err.message || 'Connection failed';
      // Decorate generic errors (e.g. Safari's "TypeError") with mixed-content guidance
      const mixedHint = getMixedContentErrorHint(host, protocol);
      if (mixedHint) {
        message = `${message}. ${mixedHint}`;
      }
      setState({ status: 'error', message });
      onStatusChangeRef.current('error', message);
      onBridgeChangeRef.current?.(null);
    }
  }, [host, password, protocol]);

  // Connect on mount
  useEffect(() => {
    mountedRef.current = true;
    connect();
    return () => {
      mountedRef.current = false;
      bridgeRef.current?.disconnect();
      bridgeRef.current = null;
      onBridgeChangeRef.current?.(null);
    };
  }, [connect]);

  // --- Connected state (with optional reconnection banner) ---
  if (state.status === 'connected') {
    return (
      <SessionErrorBoundary>
        <div className="remote-session">
          {reconnection && (
            <ReconnectionBanner state={reconnection} />
          )}
          <WebviewApp />
        </div>
      </SessionErrorBoundary>
    );
  }

  // --- Error state ---
  if (state.status === 'error') {
    return (
      <SessionErrorBoundary>
        <div className="remote-session-status">
          <div className="remote-session-error">
            <i className="codicon codicon-warning" />
            <span>{state.message}</span>
          </div>
          <button className="remote-session-retry" onClick={connect}>
            Retry
          </button>
        </div>
      </SessionErrorBoundary>
    );
  }

  // --- Connecting state ---
  return (
    <SessionErrorBoundary>
      <div className="remote-session-status">
        <div className="remote-session-connecting">
          <div className="remote-session-spinner" />
          <span>Connecting to {host}…</span>
        </div>
      </div>
    </SessionErrorBoundary>
  );
}

// ---------------------------------------------------------------------------
// Reconnection banner (slim bar at top — chat stays fully visible)
// ---------------------------------------------------------------------------

function ReconnectionBanner({ state }: { state: ReconnectionState }) {
  if (state.status === 'reconnected') {
    return (
      <div className="reconnect-banner reconnect-banner--success">
        <i className="codicon codicon-check reconnect-banner__icon--success" />
        <span className="reconnect-banner__text">Reconnected</span>
      </div>
    );
  }

  if (state.status === 'failed') {
    return (
      <div className="reconnect-banner reconnect-banner--failed">
        <i className="codicon codicon-warning reconnect-banner__icon--failed" />
        <span className="reconnect-banner__text">Unable to reconnect</span>
        {state.retryNow && (
          <button className="reconnect-banner__btn" onClick={state.retryNow}>
            Retry
          </button>
        )}
      </div>
    );
  }

  // --- Reconnecting ---
  return (
    <div className="reconnect-banner reconnect-banner--reconnecting">
      <div className="reconnect-banner__spinner" />
      <span className="reconnect-banner__text">
        Connection lost · Reconnecting
        {state.attempt > 1 ? ` (attempt ${state.attempt})` : ''}
        {state.nextRetryMs ? ` · ${Math.ceil(state.nextRetryMs / 1000)}s` : '…'}
      </span>
      {state.retryNow && (
        <button className="reconnect-banner__btn" onClick={state.retryNow}>
          Retry Now
        </button>
      )}
    </div>
  );
}
