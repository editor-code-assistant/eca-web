/**
 * RemoteProduct — orchestrates multiple remote ECA connections.
 *
 * Manages the connection lifecycle:
 * - Stores connections in localStorage (via storage/connections.ts)
 * - Tests connectivity before adding (via bridge/connection.ts)
 * - Renders a tab bar for switching (ConnectionBar)
 * - Renders either the connect form or the active session
 *
 * Supports deep-linking via `?host=...&pass=...` query params.
 */

import { useCallback, useEffect, useState } from 'react';
import { testConnection } from '../bridge/connection';
import type { WebBridge } from '../bridge/transport';
import type { ChatEntry } from '../bridge/types';
import type { Protocol } from '../bridge/utils';
import { ChatSidebar, ChatSidebarToggle } from '../components/ChatSidebar';
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
  const [activeBridge, setActiveBridge] = useState<WebBridge | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [chatEntries, setChatEntries] = useState<ChatEntry[]>([]);
  const [selectedChatId, setSelectedChatId] = useState<string | null>(null);

  // --- Persistence ---

  useEffect(() => {
    saveConnections(entries.map(({ id, host, password, protocol }) => ({ id, host, password, protocol })));
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

  // --- Listen for sidebar toggle from webview ---

  useEffect(() => {
    const handler = () => setSidebarOpen((prev) => !prev);
    window.addEventListener('eca-toggle-sidebar', handler);
    return () => window.removeEventListener('eca-toggle-sidebar', handler);
  }, []);

  // --- Guard stale activeId ---

  useEffect(() => {
    if (activeId && entries.length > 0 && !entries.find((e) => e.id === activeId)) {
      setActiveId(null);
    }
  }, [entries, activeId]);

  // --- Connection management ---

  const addConnection = useCallback(async (host: string, password: string, protocol?: Protocol) => {
    setFormConnecting(true);
    setFormError(null);

    try {
      const error = await testConnection(host, password, protocol);
      if (error) {
        setFormError(error);
        return;
      }

      // If a connection to this host already exists, switch to it
      const existing = entries.find((e) => e.host === host);
      if (existing) {
        // Update password/protocol in case they changed
        if (existing.password !== password || existing.protocol !== protocol) {
          setEntries((prev) =>
            prev.map((e) => (e.id === existing.id ? { ...e, password, protocol } : e)),
          );
        }
        setActiveId(existing.id);
        setShowForm(false);
        return;
      }

      const id = crypto.randomUUID();
      setEntries((prev) => [...prev, { id, host, password, protocol, status: 'idle' }]);
      setActiveId(id);
      setShowForm(false);
    } catch {
      setFormError('Unexpected error. Please try again.');
    } finally {
      setFormConnecting(false);
    }
  }, [entries]);

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

  const handleBridgeChange = useCallback((bridge: WebBridge | null) => {
    setActiveBridge(bridge);
    if (bridge) {
      bridge.onChatListChanged((entries, selected) => {
        setChatEntries(entries);
        setSelectedChatId(selected);
      });
      setChatEntries(bridge.getChatEntries());
      setSelectedChatId(bridge.getSelectedChatId());
    } else {
      setChatEntries([]);
      setSelectedChatId(null);
    }
  }, []);

  const toggleSidebar = useCallback(() => {
    setSidebarOpen((prev) => !prev);
  }, []);

  // --- Render ---

  const activeEntry = entries.find((e) => e.id === activeId);
  const shouldShowForm = showForm || entries.length === 0 || !activeEntry;
  const showSidebar = !shouldShowForm && activeBridge;

  return (
    <div className="remote-product">
      {entries.length > 0 && (
        <ConnectionBar
          entries={entries}
          activeId={activeId}
          onSwitch={switchConnection}
          onRemove={removeConnection}
          onAdd={() => { setShowForm(true); setFormError(null); }}
          leftSlot={showSidebar ? <ChatSidebarToggle onClick={toggleSidebar} /> : undefined}
        />
      )}

      <div className="remote-product-body">
        {showSidebar && (
          <ChatSidebar
            bridge={activeBridge}
            chats={chatEntries}
            selectedId={selectedChatId}
            mobileOpen={sidebarOpen}
            onMobileClose={() => setSidebarOpen(false)}
          />
        )}

        <div className="remote-product-content">
          {shouldShowForm ? (
            <ConnectForm
              onConnect={(host, password, protocol) => addConnection(host, password, protocol)}
              isConnecting={formConnecting}
              error={formError}
            />
          ) : (
            <RemoteSession
              key={activeEntry.id}
              host={activeEntry.host}
              password={activeEntry.password}
              protocol={activeEntry.protocol}
              onStatusChange={(status, error) =>
                handleStatusChange(activeEntry.id, status, error)
              }
              onBridgeChange={handleBridgeChange}
            />
          )}
        </div>
      </div>
    </div>
  );
}
