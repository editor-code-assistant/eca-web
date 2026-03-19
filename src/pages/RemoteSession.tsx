import { useCallback, useEffect, useRef, useState } from 'react';
import { WebBridge } from '../bridge/transport';
import WebviewApp from '@webview/App';
import './RemoteSession.css';

export type SessionStatus = 'connecting' | 'connected' | 'error';

interface RemoteSessionProps {
  host: string;
  token: string;
  onStatusChange: (status: SessionStatus, error?: string) => void;
}

export function RemoteSession({ host, token, onStatusChange }: RemoteSessionProps) {
  const [state, setState] = useState<
    | { status: 'connecting' }
    | { status: 'connected' }
    | { status: 'error'; message: string }
  >({ status: 'connecting' });

  const bridgeRef = useRef<WebBridge | null>(null);
  const mountedRef = useRef(true);
  const onStatusChangeRef = useRef(onStatusChange);
  onStatusChangeRef.current = onStatusChange;

  const connect = useCallback(async () => {
    setState({ status: 'connecting' });
    onStatusChangeRef.current('connecting');

    // Disconnect any existing bridge
    bridgeRef.current?.disconnect();

    const bridge = new WebBridge(host, token);
    bridgeRef.current = bridge;

    try {
      await bridge.connect();
      if (!mountedRef.current) {
        bridge.disconnect();
        return;
      }
      setState({ status: 'connected' });
      onStatusChangeRef.current('connected');
    } catch (err: any) {
      bridge.disconnect();
      if (!mountedRef.current) return;
      bridgeRef.current = null;
      const message = err.message || 'Connection failed';
      setState({ status: 'error', message });
      onStatusChangeRef.current('error', message);
    }
  }, [host, token]);

  // Connect on mount
  useEffect(() => {
    mountedRef.current = true;
    connect();
    return () => {
      mountedRef.current = false;
      bridgeRef.current?.disconnect();
      bridgeRef.current = null;
    };
  }, [connect]);

  if (state.status === 'connected') {
    return (
      <div className="remote-session">
        <WebviewApp />
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <div className="remote-session-status">
        <div className="remote-session-error">
          <i className="codicon codicon-warning" />
          <span>{state.message}</span>
        </div>
        <button className="remote-session-retry" onClick={connect}>
          Retry
        </button>
      </div>
    );
  }

  // Connecting
  return (
    <div className="remote-session-status">
      <div className="remote-session-connecting">
        <div className="remote-session-spinner" />
        <span>Connecting to {host}…</span>
      </div>
    </div>
  );
}
