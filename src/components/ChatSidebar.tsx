/**
 * ChatSidebar — displays a list of chats in a left sidebar panel.
 *
 * On desktop (≥768px): always visible as a fixed-width left column.
 * On mobile (<768px): hidden off-screen, toggled via a hamburger button
 * rendered in the connection bar area.
 *
 * Chat data (entries + selectedId) is owned by the parent and passed as props.
 * Actions (select, new, delete) are forwarded to the WebBridge.
 */

import { useCallback } from 'react';
import type { WebBridge } from '../bridge/transport';
import type { ChatEntry, WorkspaceFolder } from '../bridge/types';
import './ChatSidebar.css';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ChatSidebarProps {
  bridge: WebBridge | null;
  chats: ChatEntry[];
  selectedId: string | null;
  /** Workspace folders from the current server session (may be plain path strings). */
  workspaceFolders?: (WorkspaceFolder | string)[];
  /** Whether the mobile drawer is open (controlled by parent). */
  mobileOpen: boolean;
  /** Called when the mobile drawer should close (backdrop tap, item select). */
  onMobileClose: () => void;
  /** Current trust mode state. */
  trust?: boolean;
  /** Called when the user toggles trust mode. */
  onToggleTrust?: () => void;
}

// ---------------------------------------------------------------------------
// Hamburger toggle (rendered separately in the connection bar)
// ---------------------------------------------------------------------------

export function ChatSidebarToggle({ onClick }: { onClick: () => void }) {
  return (
    <button
      className="chat-sidebar-toggle"
      onClick={onClick}
      title="Toggle chat list"
      aria-label="Toggle chat list"
    >
      <i className="codicon codicon-three-bars" />
    </button>
  );
}

// ---------------------------------------------------------------------------
// Main sidebar component
// ---------------------------------------------------------------------------

export function ChatSidebar({ bridge, chats = [], selectedId, workspaceFolders = [], mobileOpen, onMobileClose, trust = false, onToggleTrust }: ChatSidebarProps) {
  const handleSelect = useCallback(
    (chatId: string) => {
      bridge?.selectChat(chatId);
      onMobileClose();
    },
    [bridge, onMobileClose],
  );

  const handleNewChat = useCallback(() => {
    bridge?.newChat();
    onMobileClose();
  }, [bridge, onMobileClose]);



  return (
    <>
      {/* Mobile overlay backdrop */}
      <div
        className={`chat-sidebar-overlay ${mobileOpen ? 'visible' : ''}`}
        onClick={onMobileClose}
      />

      {/* Sidebar panel */}
      <div className={`chat-sidebar ${mobileOpen ? 'open' : ''}`}>
        {workspaceFolders.length > 0 && (() => {
          const folder = workspaceFolders[0];
          // Server sends workspace folders as plain path strings OR {name, uri} objects
          const fullPath = typeof folder === 'string' ? folder : (folder.uri?.replace(/^file:\/\//, '') ?? folder.name ?? '');
          const displayName = (typeof folder === 'string' ? null : folder.name) || fullPath.split('/').filter(Boolean).pop() || fullPath;
          return (
            <div className="chat-sidebar-workspace" title={fullPath}>
              <i className="codicon codicon-folder" />
              <span className="chat-sidebar-workspace-name">{displayName}</span>
            </div>
          );
        })()}

        <div className="chat-sidebar-header">
          <span className="chat-sidebar-title">Chats</span>
          <button
            className="chat-sidebar-new"
            onClick={handleNewChat}
            title="New chat"
          >
            <i className="codicon codicon-add" />
          </button>
        </div>

        <div className="chat-sidebar-list">
          {chats.length === 0 ? (
            <div className="chat-sidebar-empty">
              <i className="codicon codicon-comment-discussion" />
              <span>No chats yet</span>
            </div>
          ) : (
            chats.map((chat) => (
              <button
                key={chat.id}
                className={`chat-sidebar-item ${chat.id === selectedId ? 'active' : ''}`}
                onClick={() => handleSelect(chat.id)}
                title={chat.title}
              >
                <i className="codicon codicon-comment chat-sidebar-icon" />
                <span className="chat-sidebar-label">{chat.title}</span>
                {chat.status === 'running' && (
                  <span className="chat-sidebar-status running" />
                )}
              </button>
            ))
          )}
        </div>

        {onToggleTrust && (
          <button
            className={`chat-sidebar-trust ${trust ? 'trust-on' : 'trust-off'}`}
            onClick={onToggleTrust}
            title={trust
              ? 'Trust ON — tool calls are auto-accepted'
              : 'Trust OFF — tool calls require approval'}
          >
            <i className={`codicon ${trust ? 'codicon-unlock' : 'codicon-lock'}`} />
            <span className="chat-sidebar-trust-label">
              Trust {trust ? 'ON' : 'OFF'}
            </span>
            <span className={`chat-sidebar-trust-dot ${trust ? 'on' : 'off'}`} />
          </button>
        )}
      </div>
    </>
  );
}

export { type ChatSidebarProps };
