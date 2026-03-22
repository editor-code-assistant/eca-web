/**
 * Shared utility functions for the bridge layer.
 *
 * Centralizes protocol resolution and HTTP helpers so that
 * api.ts, transport.ts, and connection-testing code all
 * use the same logic.
 */

export type Protocol = 'http' | 'https';

/** RFC 1918 + loopback regex — matches private/local network hosts. */
const LOCAL_NETWORK_RE =
  /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.|127\.|localhost)/i;

/**
 * Returns true when `host` targets a private/local network address.
 * Used for protocol defaults and Chrome Local Network Access hints.
 */
export function isLocalNetworkHost(host: string): boolean {
  return LOCAL_NETWORK_RE.test(host);
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
 * When the target URL points to a private/local address, returns
 * `{ targetAddressSpace: "local" }` so Chrome surfaces its LNA
 * permission prompt instead of silently blocking the request.
 *
 * @see https://developer.chrome.com/blog/local-network-access
 */
export function localNetworkFetchOptions(url: string): RequestInit {
  try {
    const host = new URL(url).hostname;
    if (isLocalNetworkHost(host)) {
      return { targetAddressSpace: 'local' } as RequestInit;
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
 * Automatically adds `targetAddressSpace: "local"` for private-network
 * URLs to cooperate with Chrome's Local Network Access restrictions.
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
