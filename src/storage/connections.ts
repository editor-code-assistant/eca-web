/**
 * LocalStorage persistence for remote connections.
 *
 * Handles saving/loading the connection list and active connection ID.
 * Includes one-time migration from the legacy single-connection format.
 */

import type { Protocol } from '../bridge/utils';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Connection {
  id: string;
  host: string;
  password: string;
  protocol?: Protocol;
}

// ---------------------------------------------------------------------------
// Storage keys
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'eca-web-connections';
const ACTIVE_KEY = 'eca-web-active-id';
const LEGACY_KEY = 'eca-remote-connection';

// ---------------------------------------------------------------------------
// Load / Save
// ---------------------------------------------------------------------------

/**
 * Load saved connections from localStorage.
 * On first run, migrates from the legacy single-connection format.
 */
export function loadConnections(): Connection[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* corrupted data — ignore */ }

  // Migrate from legacy single-connection format
  try {
    const legacy = localStorage.getItem(LEGACY_KEY);
    if (legacy) {
      const { host, token: password } = JSON.parse(legacy);
      if (host && password) {
        const conn: Connection = { id: crypto.randomUUID(), host, password };
        localStorage.setItem(STORAGE_KEY, JSON.stringify([conn]));
        localStorage.setItem(ACTIVE_KEY, conn.id);
        localStorage.removeItem(LEGACY_KEY);
        return [conn];
      }
    }
  } catch { /* corrupted legacy data — ignore */ }

  return [];
}

/** Load the active connection ID from localStorage. */
export function loadActiveId(): string | null {
  return localStorage.getItem(ACTIVE_KEY) || null;
}

/** Persist the connection list (credentials only, no runtime state). */
export function saveConnections(connections: Connection[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(connections));
}

/** Persist the active connection ID. */
export function saveActiveId(id: string | null): void {
  if (id) localStorage.setItem(ACTIVE_KEY, id);
  else localStorage.removeItem(ACTIVE_KEY);
}

// ---------------------------------------------------------------------------
// Deep-link
// ---------------------------------------------------------------------------

/**
 * Consume a `?host=...&pass=...` deep-link from the URL.
 *
 * If present, strips the query params from the URL bar (so they
 * don't linger or get bookmarked) and returns the host+password.
 * Returns null if no deep-link params are found.
 */
export function consumeDeepLink(): { host: string; password: string; protocol?: Protocol } | null {
  const params = new URLSearchParams(window.location.search);
  const host = params.get('host');
  const port = params.get('port');
  const password = params.get('pass');
  const proto = params.get('protocol') as Protocol | null;
  if (host && password) {
    window.history.replaceState({}, '', window.location.pathname);
    // If port is provided separately, combine it; otherwise use host as-is
    // (which may already contain a port, e.g. host=192.168.1.42:7777)
    const fullHost = port ? `${host}:${port}` : host;
    return { host: fullHost, password, protocol: proto ?? undefined };
  }
  return null;
}
