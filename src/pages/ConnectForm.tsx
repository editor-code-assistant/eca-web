import { useState } from 'react';
import type { Protocol } from '../bridge/utils';
import './ConnectForm.css';

interface ConnectFormProps {
  onConnect: (host: string, password: string, protocol: Protocol) => Promise<void>;
  error?: string | null;
  isConnecting?: boolean;
}

export function ConnectForm({ onConnect, error, isConnecting }: ConnectFormProps) {
  const [host, setHost] = useState('');
  const [port, setPort] = useState('7777');
  const [password, setPassword] = useState('');
  const [protocol, setProtocol] = useState<Protocol>('https');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedHost = host.trim();
    const trimmedPort = port.trim();
    if (trimmedHost && trimmedPort && password.trim()) {
      onConnect(`${trimmedHost}:${trimmedPort}`, password.trim(), protocol);
    }
  };

  return (
    <div className="connect-page">
      <div className="connect-card">
        <div className="connect-logo">
          <img src="/logo.svg" alt="ECA" />
        </div>
        <h1>ECA Remote</h1>
        <p className="connect-subtitle">Connect to a running ECA session</p>

        <form onSubmit={handleSubmit} className="connect-form">
          <div className="connect-host-row">
            <div className="connect-field connect-field-host">
              <label htmlFor="host">Host</label>
              <div className="connect-host-input-group">
                <button
                  type="button"
                  className="connect-protocol-prefix"
                  onClick={() => setProtocol((p) => (p === 'https' ? 'http' : 'https'))}
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
            <div className="connect-field connect-field-port">
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

          <button
            type="submit"
            className="connect-button"
            disabled={isConnecting || !host.trim() || !port.trim() || !password.trim()}
          >
            {isConnecting ? 'Connecting…' : 'Connect'}
          </button>
        </form>

        {error && <div className="connect-error">{error}</div>}

        <p className="connect-hint">
          Start ECA with <code>remote.enabled: true</code> in your config.
          <br />
          The connection URL is printed to stderr on startup.
        </p>
      </div>
    </div>
  );
}
