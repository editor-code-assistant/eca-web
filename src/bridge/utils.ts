/**
 * Shared utility functions for the bridge layer.
 *
 * Centralizes protocol resolution and HTTP helpers so that
 * api.ts, transport.ts, and connection-testing code all
 * use the same logic.
 */

export type Protocol = 'http' | 'https';

/** RFC 1918 private addresses (192.168.x, 10.x, 172.16-31.x). */
const PRIVATE_NETWORK_RE =
  /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/i;

/** Loopback addresses (127.x, localhost). */
const LOOPBACK_RE = /^(127\.|localhost)/i;

/**
 * Returns true when `host` targets a private/local network address.
 * Used for protocol defaults and Chrome Local Network Access hints.
 */
export function isLocalNetworkHost(host: string): boolean {
  return PRIVATE_NETWORK_RE.test(host) || LOOPBACK_RE.test(host);
}

/**
 * Chrome LNA `targetAddressSpace` value for a given host.
 *
 * The fetch spec defines three address spaces:
 * - `"local"` — loopback (127.x, localhost)
 * - `"private"` — RFC 1918 (10.x, 172.16-31.x, 192.168.x)
 * - `undefined` — public / not applicable
 *
 * Chrome validates that the resolved IP matches the declared space;
 * a mismatch causes the request to fail.
 */
export function targetAddressSpace(host: string): string | undefined {
  if (LOOPBACK_RE.test(host)) return 'local';
  if (PRIVATE_NETWORK_RE.test(host)) return 'private';
  return undefined;
}

/**
 * Resolve the HTTP protocol for a given host string.
 * When an explicit protocol is provided it is used as-is;
 * otherwise private/loopback addresses → http, everything else → https.
 */
export function resolveProtocol(host: string, protocol?: Protocol): Protocol {
  if (protocol) return protocol;
  return isLocalNetworkHost(host) ? 'http' : 'https';
}

/**
 * Build the base API URL for a host, e.g. "https://myhost:7888/api/v1".
 */
export function resolveBaseUrl(host: string, protocol?: Protocol): string {
  return `${resolveProtocol(host, protocol)}://${host}/api/v1`;
}

/**
 * Build extra fetch options for Chrome Local Network Access (LNA).
 *
 * Sets `targetAddressSpace` to the correct value (`"private"` for
 * RFC 1918, `"local"` for loopback) so Chrome surfaces its LNA
 * permission prompt and relaxes mixed-content blocking.
 *
 * @see https://developer.chrome.com/blog/local-network-access
 */
export function localNetworkFetchOptions(url: string): RequestInit {
  try {
    const space = targetAddressSpace(new URL(url).hostname);
    if (space) {
      return { targetAddressSpace: space } as RequestInit;
    }
  } catch {
    // invalid URL — ignore
  }
  return {};
}

/**
 * Fetch with an abort-based timeout.
 *
 * Wraps the standard `fetch` and aborts the request if it exceeds
 * `timeoutMs` milliseconds. The AbortError can be caught upstream
 * to show a user-friendly timeout message.
 *
 * Automatically sets `targetAddressSpace` for private/loopback URLs
 * to cooperate with Chrome's Local Network Access restrictions.
 */
export async function fetchWithTimeout(
  url: string,
  init?: RequestInit,
  timeoutMs = 10_000,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...localNetworkFetchOptions(url),
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}
