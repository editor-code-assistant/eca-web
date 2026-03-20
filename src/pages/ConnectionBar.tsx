/**
 * ConnectionBar — tab bar for managing multiple remote connections.
 *
 * Displays one tab per connection with status indicator, host label,
 * and close button. Includes an "add" button to open the connect form.
 */

import type { Protocol } from '../bridge/utils';
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Truncate a host string to fit in the tab bar. */
function formatHost(host: string): string {
  const clean = host.replace(/^https?:\/\//, '');
  return clean.length > 28 ? clean.slice(0, 26) + '…' : clean;
}

/** Map connection status to a CSS dot class. */
function dotClass(status: ConnectionEntry['status']): string {
  switch (status) {
    case 'connected':  return 'dot-connected';
    case 'connecting': return 'dot-connecting';
    case 'error':      return 'dot-error';
    default:           return 'dot-idle';
  }
}
