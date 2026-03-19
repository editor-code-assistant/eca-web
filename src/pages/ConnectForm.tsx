import { useState } from 'react';
import './ConnectForm.css';

interface ConnectFormProps {
  onConnect: (host: string, token: string) => Promise<void>;
  error?: string | null;
  isConnecting?: boolean;
}

export function ConnectForm({ onConnect, error, isConnecting }: ConnectFormProps) {
  const [host, setHost] = useState('');
  const [token, setToken] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (host.trim() && token.trim()) {
      onConnect(host.trim(), token.trim());
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
            <label htmlFor="token">Password / Token</label>
            <input
              id="token"
              type="password"
              placeholder="Password or bearer token"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              disabled={isConnecting}
            />
          </div>

          <button
            type="submit"
            className="connect-button"
            disabled={isConnecting || !host.trim() || !token.trim()}
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
