/**
 * LocalStorage persistence for remote connections.
 *
 * Handles saving/loading the connection list and active connection ID.
 * Includes one-time migration from the legacy single-connection format.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Connection {
  id: string;
  host: string;
  token: string;
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
      const { host, token } = JSON.parse(legacy);
      if (host && token) {
        const conn: Connection = { id: crypto.randomUUID(), host, token };
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
 * Consume a `?host=...&token=...` deep-link from the URL.
 *
 * If present, strips the query params from the URL bar (so they
 * don't linger or get bookmarked) and returns the host+token.
 * Returns null if no deep-link params are found.
 */
export function consumeDeepLink(): { host: string; token: string } | null {
  const params = new URLSearchParams(window.location.search);
  const host = params.get('host');
  const token = params.get('token');
  if (host && token) {
    window.history.replaceState({}, '', window.location.pathname);
    return { host, token };
  }
  return null;
}
