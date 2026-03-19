/**
 * RemoteProduct — orchestrates multiple remote ECA connections.
 *
 * Manages the connection lifecycle:
 * - Stores connections in localStorage (via storage/connections.ts)
 * - Tests connectivity before adding (via bridge/connection.ts)
 * - Renders a tab bar for switching (ConnectionBar)
 * - Renders either the connect form or the active session
 *
 * Supports deep-linking via `?host=...&token=...` query params.
 */

import { useCallback, useEffect, useState } from 'react';
import { testConnection } from '../bridge/connection';
import {
  consumeDeepLink,
  loadActiveId,
  loadConnections,
  saveActiveId,
  saveConnections,
} from '../storage/connections';
import { ConnectionBar, type ConnectionEntry } from './ConnectionBar';
import { ConnectForm } from './ConnectForm';
import { RemoteSession, type SessionStatus } from './RemoteSession';
import './RemoteProduct.css';

export function RemoteProduct() {
  const [entries, setEntries] = useState<ConnectionEntry[]>(() =>
    loadConnections().map((c) => ({ ...c, status: 'idle' as const })),
  );
  const [activeId, setActiveId] = useState<string | null>(loadActiveId);
  const [showForm, setShowForm] = useState(false);
  const [formConnecting, setFormConnecting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // --- Persistence ---

  useEffect(() => {
    saveConnections(entries.map(({ id, host, token }) => ({ id, host, token })));
  }, [entries]);

  useEffect(() => {
    saveActiveId(activeId);
  }, [activeId]);

  // --- Deep-link on mount ---

  useEffect(() => {
    const deepLink = consumeDeepLink();
    if (deepLink) {
      const id = crypto.randomUUID();
      setEntries((prev) => [...prev, { id, ...deepLink, status: 'idle' }]);
      setActiveId(id);
      setShowForm(false);
    }
  }, []);

  // --- Guard stale activeId ---

  useEffect(() => {
    if (activeId && entries.length > 0 && !entries.find((e) => e.id === activeId)) {
      setActiveId(null);
    }
  }, [entries, activeId]);

  // --- Connection management ---

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

  // --- Render ---

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
