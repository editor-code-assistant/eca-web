import { useEffect, useRef, useState } from 'react';
import type { Protocol } from '../bridge/utils';
import './ConnectForm.css';

/** Discovery progress reported by the parent during auto-scan. */
export interface DiscoveryProgress {
  /** Total ports being scanned */
  total: number;
  /** How many have been checked so far */
  checked: number;
  /** Ports where an ECA server was found */
  found: number[];
}

interface ConnectFormProps {
  /** Single-port connect (auto-discover OFF) */
  onConnect: (host: string, password: string, protocol: Protocol) => Promise<void>;
  /** Multi-port auto-discovery (auto-discover ON) */
  onDiscover: (host: string, password: string, protocol: Protocol) => Promise<void>;
  error?: string | null;
  isConnecting?: boolean;
  /** Live progress during auto-discovery scan */
  discovery?: DiscoveryProgress | null;
}

export function ConnectForm({ onConnect, onDiscover, error, isConnecting, discovery }: ConnectFormProps) {
  const [host, setHost] = useState('');
  const [port, setPort] = useState('7777');
  const [password, setPassword] = useState('');
  const [protocol, setProtocol] = useState<Protocol>('https');
  const [autoDiscover, setAutoDiscover] = useState(true);
  const userToggledProtocol = useRef(false);

  // Auto-detect HTTP for private/local network addresses
  useEffect(() => {
    if (userToggledProtocol.current) return;
    const h = host.trim();
    const isPrivate =
      /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.|127\.|localhost)/i.test(h);
    setProtocol(isPrivate ? 'http' : 'https');
  }, [host]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedHost = host.trim();
    if (!trimmedHost || !password.trim()) return;

    if (autoDiscover) {
      onDiscover(trimmedHost, password.trim(), protocol);
    } else {
      const trimmedPort = port.trim();
      if (!trimmedPort) return;
      onConnect(`${trimmedHost}:${trimmedPort}`, password.trim(), protocol);
    }
  };

  const canSubmit = autoDiscover
    ? !!host.trim() && !!password.trim()
    : !!host.trim() && !!port.trim() && !!password.trim();

  return (
    <div className="connect-page">
      <div className="connect-page-orb connect-page-orb--1" aria-hidden="true" />
      <div className="connect-page-orb connect-page-orb--2" aria-hidden="true" />
      <div className="connect-page-orb connect-page-orb--3" aria-hidden="true" />
      <div className="connect-card">
        <div className="connect-logo">
          <img src="/logo.svg" alt="ECA" />
        </div>
        <h1>ECA Remote</h1>
        <p className="connect-subtitle">Connect to a running ECA session</p>

        <form onSubmit={handleSubmit} className="connect-form">
          <div className="connect-field">
            <label htmlFor="host">Host</label>
            <div className="connect-host-input-group">
              <button
                type="button"
                className="connect-protocol-prefix"
                onClick={() => { userToggledProtocol.current = true; setProtocol((p) => (p === 'https' ? 'http' : 'https')); }}
                disabled={isConnecting}
                title="Click to toggle HTTP / HTTPS"
              >
                {protocol}://
              </button>
              <input
                id="host"
                type="text"
                placeholder="192.168.1.42"
                value={host}
                onChange={(e) => setHost(e.target.value)}
                disabled={isConnecting}
                autoFocus
              />
            </div>
          </div>

          <div className="connect-field">
            <label htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              placeholder="Password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={isConnecting}
            />
          </div>

          <div className="connect-discovery-row">
            <label className="connect-toggle" htmlFor="auto-discover">
              <input
                id="auto-discover"
                type="checkbox"
                checked={autoDiscover}
                onChange={(e) => setAutoDiscover(e.target.checked)}
                disabled={isConnecting}
              />
              <span className="connect-toggle-track">
                <span className="connect-toggle-thumb" />
              </span>
              <span className="connect-toggle-label">Auto-discover sessions</span>
            </label>
            <span className="connect-discovery-hint">
              {autoDiscover ? 'Scan ports 7777–7787' : `Port ${port || '7777'}`}
            </span>
          </div>

          {!autoDiscover && (
            <div className="connect-field connect-field-port-full">
              <label htmlFor="port">Port</label>
              <input
                id="port"
                type="number"
                placeholder="7777"
                min={1}
                max={65535}
                value={port}
                onChange={(e) => setPort(e.target.value)}
                disabled={isConnecting}
              />
            </div>
          )}

          <button
            type="submit"
            className="connect-button"
            disabled={isConnecting || !canSubmit}
          >
            {isConnecting
              ? autoDiscover
                ? 'Scanning…'
                : 'Connecting…'
              : autoDiscover
                ? 'Discover & Connect'
                : 'Connect'}
          </button>
        </form>

        {/* Discovery progress bar */}
        {discovery && (
          <div className="connect-discovery-progress">
            <div className="connect-discovery-bar">
              <div
                className="connect-discovery-bar-fill"
                style={{ width: `${(discovery.checked / discovery.total) * 100}%` }}
              />
            </div>
            <span className="connect-discovery-status">
              {discovery.checked < discovery.total
                ? `Scanning… ${discovery.checked}/${discovery.total} ports${discovery.found.length > 0 ? ` (${discovery.found.length} found)` : ''}`
                : discovery.found.length > 0
                  ? `Found ${discovery.found.length} server${discovery.found.length > 1 ? 's' : ''} on port${discovery.found.length > 1 ? 's' : ''} ${discovery.found.join(', ')}`
                  : 'No servers found'}
            </span>
          </div>
        )}

        {error && <div className="connect-error">{error}</div>}

        <div className="connect-divider">
          <span>Setup</span>
        </div>

        <p className="connect-hint">
          Enable <code>remote.enabled: true</code> in your ECA config.
          {' '}<a href="https://eca.dev/config/remote" target="_blank" rel="noopener noreferrer">Learn more →</a>
        </p>


      </div>
    </div>
  );
}
