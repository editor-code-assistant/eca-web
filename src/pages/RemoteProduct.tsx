import { useCallback, useEffect, useState } from 'react';
import { ConnectForm } from './ConnectForm';
import { RemoteSession, SessionStatus } from './RemoteSession';
import './RemoteProduct.css';

// --- Connection types ---

interface Connection {
  id: string;
  host: string;
  token: string;
}

interface ConnectionEntry extends Connection {
  status: SessionStatus | 'idle';
  error?: string;
}

// --- LocalStorage ---

const STORAGE_KEY = 'eca-web-connections';
const ACTIVE_KEY = 'eca-web-active-id';
const LEGACY_KEY = 'eca-remote-connection';

function loadConnections(): Connection[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }

  // Migrate from legacy single-connection format
  try {
    const legacy = localStorage.getItem(LEGACY_KEY);
    if (legacy) {
      const { host, token } = JSON.parse(legacy);
      if (host && token) {
        const conn: Connection = { id: crypto.randomUUID(), host, token };
        localStorage.setItem(STORAGE_KEY, JSON.stringify([conn]));
        localStorage.setItem(ACTIVE_KEY, conn.id);
        localStorage.removeItem(LEGACY_KEY);
        return [conn];
      }
    }
  } catch { /* ignore */ }

  return [];
}

function loadActiveId(): string | null {
  return localStorage.getItem(ACTIVE_KEY) || null;
}

function saveConnections(connections: Connection[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(connections));
}

function saveActiveId(id: string | null): void {
  if (id) localStorage.setItem(ACTIVE_KEY, id);
  else localStorage.removeItem(ACTIVE_KEY);
}

// --- URL deep-link ---

function consumeDeepLink(): { host: string; token: string } | null {
  const params = new URLSearchParams(window.location.search);
  const host = params.get('host');
  const token = params.get('token');
  if (host && token) {
    window.history.replaceState({}, '', window.location.pathname);
    return { host, token };
  }
  return null;
}

// --- Component ---

async function fetchWithTimeout(url: string, init?: RequestInit, timeoutMs = 10000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function testConnection(host: string, token: string): Promise<string | null> {
  const protocol = host.startsWith('localhost') || host.startsWith('127.0.0.1')
    ? 'http' : 'https';
  const baseUrl = `${protocol}://${host}/api/v1`;

  // 1. Test host reachability (health endpoint — no auth)
  try {
    const res = await fetchWithTimeout(`${baseUrl}/health`);
    if (!res.ok) {
      return res.status === 404
        ? 'No ECA server found at this address.'
        : `Host returned an error (${res.status}).`;
    }
  } catch (err: any) {
    if (err.name === 'AbortError') {
      return 'Connection timed out. Check the address and try again.';
    }
    return 'Could not reach host. Check the address and try again.';
  }

  // 2. Test authentication (session endpoint — requires auth)
  try {
    const res = await fetchWithTimeout(`${baseUrl}/session`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!res.ok) {
      return (res.status === 401 || res.status === 403)
        ? 'Authentication failed. Check your password or token.'
        : `Session check failed (${res.status}).`;
    }
  } catch (err: any) {
    if (err.name === 'AbortError') {
      return 'Authentication check timed out.';
    }
    return 'Authentication check failed.';
  }

  return null;
}

export function RemoteProduct() {
  const [entries, setEntries] = useState<ConnectionEntry[]>(() =>
    loadConnections().map((c) => ({ ...c, status: 'idle' as const })),
  );
  const [activeId, setActiveId] = useState<string | null>(loadActiveId);
  const [showForm, setShowForm] = useState(false);
  const [formConnecting, setFormConnecting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Persist
  useEffect(() => {
    saveConnections(entries.map(({ id, host, token }) => ({ id, host, token })));
  }, [entries]);

  useEffect(() => {
    saveActiveId(activeId);
  }, [activeId]);

  // Deep-link on mount
  useEffect(() => {
    const deepLink = consumeDeepLink();
    if (deepLink) {
      const id = crypto.randomUUID();
      setEntries((prev) => [...prev, { id, ...deepLink, status: 'idle' }]);
      setActiveId(id);
      setShowForm(false);
    }
  }, []);

  // Guard stale activeId
  useEffect(() => {
    if (activeId && entries.length > 0 && !entries.find((e) => e.id === activeId)) {
      setActiveId(null);
    }
  }, [entries, activeId]);

  const addConnection = useCallback(async (host: string, token: string) => {
    setFormConnecting(true);
    setFormError(null);

    try {
      const error = await testConnection(host, token);
      if (error) {
        setFormError(error);
        return;
      }

      const id = crypto.randomUUID();
      setEntries((prev) => [...prev, { id, host, token, status: 'idle' }]);
      setActiveId(id);
      setShowForm(false);
    } catch {
      setFormError('Unexpected error. Please try again.');
    } finally {
      setFormConnecting(false);
    }
  }, []);

  const removeConnection = useCallback((id: string) => {
    setEntries((prev) => {
      const remaining = prev.filter((e) => e.id !== id);
      if (id === activeId) {
        setActiveId(remaining.length > 0 ? remaining[0].id : null);
      }
      return remaining;
    });
  }, [activeId]);

  const switchConnection = useCallback((id: string) => {
    setActiveId(id);
    setShowForm(false);
  }, []);

  const handleStatusChange = useCallback(
    (connId: string, status: SessionStatus, error?: string) => {
      setEntries((prev) =>
        prev.map((e) => (e.id === connId ? { ...e, status, error } : e)),
      );
    },
    [],
  );

  const activeEntry = entries.find((e) => e.id === activeId);
  const shouldShowForm = showForm || entries.length === 0 || !activeEntry;

  return (
    <div className="remote-product">
      {entries.length > 0 && (
        <ConnectionBar
          entries={entries}
          activeId={activeId}
          onSwitch={switchConnection}
          onRemove={removeConnection}
          onAdd={() => { setShowForm(true); setFormError(null); }}
        />
      )}

      <div className="remote-product-content">
        {shouldShowForm ? (
          <ConnectForm
            onConnect={addConnection}
            isConnecting={formConnecting}
            error={formError}
          />
        ) : (
          <RemoteSession
            key={activeEntry.id}
            host={activeEntry.host}
            token={activeEntry.token}
            onStatusChange={(status, error) =>
              handleStatusChange(activeEntry.id, status, error)
            }
          />
        )}
      </div>
    </div>
  );
}

// --- Connection bar (sub-component) ---

function formatHost(host: string): string {
  const clean = host.replace(/^https?:\/\//, '');
  return clean.length > 28 ? clean.slice(0, 26) + '…' : clean;
}

function dotClass(status: ConnectionEntry['status']): string {
  switch (status) {
    case 'connected':  return 'dot-connected';
    case 'connecting': return 'dot-connecting';
    case 'error':      return 'dot-error';
    default:           return 'dot-idle';
  }
}

function ConnectionBar({
  entries,
  activeId,
  onSwitch,
  onRemove,
  onAdd,
}: {
  entries: ConnectionEntry[];
  activeId: string | null;
  onSwitch: (id: string) => void;
  onRemove: (id: string) => void;
  onAdd: () => void;
}) {
  return (
    <div className="conn-bar">
      <div className="conn-bar-tabs">
        {entries.map((entry) => {
          const isActive = entry.id === activeId;
          return (
            <button
              key={entry.id}
              className={`conn-tab ${isActive ? 'active' : ''}`}
              onClick={() => onSwitch(entry.id)}
              title={entry.host}
            >
              <span className={`conn-dot ${dotClass(isActive ? entry.status : 'idle')}`} />
              <span className="conn-label">{formatHost(entry.host)}</span>
              <span
                className="conn-close"
                role="button"
                tabIndex={0}
                onClick={(e) => { e.stopPropagation(); onRemove(entry.id); }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { e.stopPropagation(); onRemove(entry.id); }
                }}
                title="Remove connection"
              >
                <i className="codicon codicon-close" />
              </span>
            </button>
          );
        })}

        <button className="conn-add" onClick={onAdd} title="Add connection">
          <i className="codicon codicon-add" />
        </button>
      </div>
    </div>
  );
}
