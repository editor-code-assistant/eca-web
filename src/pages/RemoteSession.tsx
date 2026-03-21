import { Component, useCallback, useEffect, useRef, useState } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { WebBridge } from '../bridge/transport';
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

export type SessionStatus = 'connecting' | 'connected' | 'error';

interface RemoteSessionProps {
  host: string;
  password: string;
  protocol?: Protocol;
  onStatusChange: (status: SessionStatus, error?: string) => void;
  /** Called when the bridge instance changes (connected or disconnected). */
  onBridgeChange?: (bridge: WebBridge | null) => void;
}

export function RemoteSession({ host, password, protocol, onStatusChange, onBridgeChange }: RemoteSessionProps) {
  const [state, setState] = useState<
    | { status: 'connecting' }
    | { status: 'connected' }
    | { status: 'error'; message: string }
  >({ status: 'connecting' });

  const bridgeRef = useRef<WebBridge | null>(null);
  const mountedRef = useRef(true);
  const onStatusChangeRef = useRef(onStatusChange);
  const onBridgeChangeRef = useRef(onBridgeChange);
  onStatusChangeRef.current = onStatusChange;
  onBridgeChangeRef.current = onBridgeChange;

  const connect = useCallback(async () => {
    setState({ status: 'connecting' });
    onStatusChangeRef.current('connecting');

    // Disconnect any existing bridge
    bridgeRef.current?.disconnect();

    const bridge = new WebBridge(host, password, protocol);
    bridgeRef.current = bridge;

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
      const message = err.message || 'Connection failed';
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

  // Debug overlay — remove after debugging mobile blank page
  const debugBanner = (
    <div style={{
      position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 99999,
      background: '#1a1a2e', color: '#0f0', fontSize: '11px', padding: '6px 10px',
      fontFamily: 'monospace', borderTop: '1px solid #333', maxHeight: '30vh', overflow: 'auto',
    }}>
      <div>status: <b>{state.status}</b></div>
      <div>host: {host} | protocol: {protocol ?? 'auto'}</div>
      {state.status === 'error' && <div style={{ color: '#f44' }}>error: {state.message}</div>}
      <div>bridge connected: {String(bridgeRef.current?.isConnected() ?? false)}</div>
    </div>
  );

  const content = state.status === 'connected' ? (
    <div className="remote-session">
      <WebviewApp />
      {debugBanner}
    </div>
  ) : state.status === 'error' ? (
    <div className="remote-session-status">
      <div className="remote-session-error">
        <i className="codicon codicon-warning" />
        <span>{state.message}</span>
      </div>
      <button className="remote-session-retry" onClick={connect}>
        Retry
      </button>
      {debugBanner}
    </div>
  ) : (
    <div className="remote-session-status">
      <div className="remote-session-connecting">
        <div className="remote-session-spinner" />
        <span>Connecting to {host}…</span>
      </div>
      {debugBanner}
    </div>
  );

  return <SessionErrorBoundary>{content}</SessionErrorBoundary>;
}
