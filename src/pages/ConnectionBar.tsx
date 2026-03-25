/**
 * ConnectionBar — tab bar for managing multiple remote connections.
 *
 * Displays one tab per connection with status indicator, host label,
 * and close button. Includes an "add" button to open the connect form.
 */

import type { WorkspaceFolder } from '../bridge/types';
import type { Protocol } from '../bridge/utils';
import { extractSslipIp } from '../bridge/utils';
import type { SessionStatus } from './RemoteSession';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ConnectionEntry {
  id: string;
  host: string;
  password: string;
  protocol?: Protocol;
  status: SessionStatus | 'idle';
  error?: string;
  /** Workspace folders reported by the server once the session is connected. */
  workspaceFolders?: (WorkspaceFolder | string)[];
  /** ID of the last viewed chat — restored when reconnecting to this server. */
  lastChatId?: string;
}

interface ConnectionBarProps {
  entries: ConnectionEntry[];
  activeId: string | null;
  onSwitch: (id: string) => void;
  onRemove: (id: string) => void;
  onAdd: () => void;
  /** Optional element rendered at the start of the bar (e.g. hamburger toggle). */
  leftSlot?: React.ReactNode;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ConnectionBar({
  entries,
  activeId,
  onSwitch,
  onRemove,
  onAdd,
  leftSlot,
}: ConnectionBarProps) {
  return (
    <div className="conn-bar">
      {leftSlot}
      <div className="conn-bar-tabs">
        {entries.map((entry) => {
          const isActive = entry.id === activeId;
          const ws = getWorkspaceLabel(entry.workspaceFolders);
          const tooltip = ws
            ? `${ws.fullPath}\n${entry.host}`
            : entry.host;
          return (
            <button
              key={entry.id}
              className={`conn-tab ${isActive ? 'active' : ''}`}
              onClick={() => onSwitch(entry.id)}
              title={tooltip}
            >
              <span className={`conn-dot ${dotClass(isActive ? entry.status : 'idle')}`} />
              {ws ? (
                <span className="conn-label conn-label-rich">
                  <span className="conn-label-primary">{ws.name}</span>
                  <span className="conn-label-secondary">{formatHost(entry.host)}</span>
                </span>
              ) : (
                <span className="conn-label">{formatHost(entry.host)}</span>
              )}
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract a human-friendly workspace label from the first workspace folder.
 * Returns `null` when no workspace data is available yet (e.g. still connecting).
 */
function getWorkspaceLabel(
  folders?: (WorkspaceFolder | string)[],
): { name: string; fullPath: string } | null {
  if (!folders || folders.length === 0) return null;
  const folder = folders[0];
  const fullPath =
    typeof folder === 'string'
      ? folder
      : folder.uri?.replace(/^file:\/\//, '') ?? folder.name ?? '';
  if (!fullPath) return null;
  const name =
    (typeof folder === 'string' ? null : folder.name) ||
    fullPath.split('/').filter(Boolean).pop() ||
    fullPath;
  return { name, fullPath };
}

/**
 * Format a host string for the tab bar.
 * Converts sslip.io hostnames back to their embedded IP for readability
 * (e.g. "192-168-1-42.local.eca.dev:7777" → "192.168.1.42:7777").
 */
function formatHost(host: string): string {
  const clean = host.replace(/^https?:\/\//, '');
  const [hostPart, port] = clean.split(':');
  const ip = extractSslipIp(hostPart);
  if (ip) {
    return port ? `${ip}:${port}` : ip;
  }
  return clean.length > 28 ? clean.slice(0, 26) + '…' : clean;
}

/** Map connection status to a CSS dot class. */
function dotClass(status: ConnectionEntry['status']): string {
  switch (status) {
    case 'connected':    return 'dot-connected';
    case 'connecting':   return 'dot-connecting';
    case 'reconnecting': return 'dot-reconnecting';
    case 'error':        return 'dot-error';
    default:             return 'dot-idle';
  }
}
