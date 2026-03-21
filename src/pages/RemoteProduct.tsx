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

import { useCallback, useEffect, useRef, useState } from 'react';
import { probePort, testConnection } from '../bridge/connection';
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
import { ConnectForm, type DiscoveryProgress } from './ConnectForm';
import { RemoteSession, type SessionStatus } from './RemoteSession';
import './RemoteProduct.css';

/** Port range for auto-discovery */
const DISCOVERY_PORT_START = 7777;
const DISCOVERY_PORT_END = 7787;

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
  const [discovery, setDiscovery] = useState<DiscoveryProgress | null>(null);
  const discoveryAbortRef = useRef<AbortController | null>(null);

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

  /** Auto-discover ECA servers on ports 7777–7787 in parallel. */
  const discoverConnections = useCallback(async (host: string, password: string, protocol?: Protocol) => {
    // Abort any previous discovery
    discoveryAbortRef.current?.abort();
    const abort = new AbortController();
    discoveryAbortRef.current = abort;

    setFormConnecting(true);
    setFormError(null);

    const ports: number[] = [];
    for (let p = DISCOVERY_PORT_START; p <= DISCOVERY_PORT_END; p++) ports.push(p);

    const progress: DiscoveryProgress = { total: ports.length, checked: 0, found: [] };
    setDiscovery({ ...progress });

    await Promise.allSettled(
      ports.map(async (port) => {
        if (abort.signal.aborted) return;
        const alive = await probePort(host, port, protocol);
        if (abort.signal.aborted) return;

        progress.checked++;
        if (alive) progress.found.push(port);
        setDiscovery({ ...progress, found: [...progress.found] });
      }),
    );

    if (abort.signal.aborted) return;

    // Only error when zero servers were discovered
    if (progress.found.length === 0) {
      setFormError('No ECA servers found on ports 7777–7787. Check the host and password.');
      setFormConnecting(false);
      return;
    }

    // Create a connection entry for each found port
    let firstNewId: string | null = null;
    setEntries((prev) => {
      const next = [...prev];
      for (const port of progress.found) {
        const hostWithPort = `${host}:${port}`;
        const existing = next.find((e) => e.host === hostWithPort);
        if (existing) {
          // Update credentials if needed
          if (existing.password !== password || existing.protocol !== protocol) {
            Object.assign(existing, { password, protocol });
          }
          if (!firstNewId) firstNewId = existing.id;
        } else {
          const id = crypto.randomUUID();
          next.push({ id, host: hostWithPort, password, protocol, status: 'idle' });
          if (!firstNewId) firstNewId = id;
        }
      }
      return next;
    });

    if (firstNewId) setActiveId(firstNewId);
    setShowForm(false);
    setFormConnecting(false);
    // Clear discovery progress after a short delay to let user see the result
    setTimeout(() => setDiscovery(null), 300);
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
              onDiscover={(host, password, protocol) => discoverConnections(host, password, protocol)}
              isConnecting={formConnecting}
              error={formError}
              discovery={discovery}
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
