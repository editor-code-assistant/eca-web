/**
 * Bridge module — public API.
 *
 * The bridge connects the eca-webview (which expects postMessage
 * communication) to a remote ECA server (REST + SSE).
 *
 * Usage:
 *   import { WebBridge } from '@/bridge';
 *   const bridge = new WebBridge(host, token);
 *   await bridge.connect();
 */

export { EcaRemoteApi } from './api';
export { testConnection } from './connection';
export { SSEClient } from './sse';
export { WebBridge } from './transport';
export type { SSEEvent, SSEClientOptions } from './sse';
export type * from './types';
