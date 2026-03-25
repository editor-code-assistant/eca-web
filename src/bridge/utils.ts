/**
 * Shared utility functions for the bridge layer.
 *
 * Centralizes protocol resolution and HTTP helpers so that
 * api.ts, transport.ts, and connection-testing code all
 * use the same logic.
 */

export type Protocol = 'http' | 'https';
export type BrowserKind = 'chrome' | 'firefox' | 'safari' | 'other';

/**
 * Detect the current browser from the user-agent string.
 *
 * We only care about Chrome, Firefox and Safari because each handles
 * mixed-content / Local Network Access differently:
 * - Chrome supports `targetAddressSpace` and shows an LNA prompt
 * - Firefox and Safari block HTTPS→HTTP silently with no API escape hatch
 *
 * Order matters: Chrome's UA also contains "Safari", and many browsers
 * (Edge, Opera, Brave) contain "Chrome", which is fine — they all
 * inherit Chrome's LNA behaviour.
 */
export function detectBrowser(): BrowserKind {
  const ua = navigator.userAgent;
  // All Chromium-based browsers (Chrome, Edge, Brave, Opera, Arc…)
  // include "Chrome/" in their UA and inherit LNA support.
  if (/Chrome\//.test(ua)) return 'chrome';
  if (/Firefox\//.test(ua)) return 'firefox';
  // Real Safari has "Safari/" but NOT "Chrome/"
  if (/Safari\//.test(ua)) return 'safari';
  return 'other';
}

/** RFC 1918 private addresses (192.168.x, 10.x, 172.16-31.x). */
const PRIVATE_NETWORK_RE =
  /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/i;

/** Loopback addresses (127.x, localhost). */
const LOOPBACK_RE = /^(127\.|localhost)/i;

/** sslip.io-style hostname under local.eca.dev with an embedded IP (e.g. 192-168-1-1.local.eca.dev). */
const SSLIP_LOCAL_RE =
  /^(\d{1,3})-(\d{1,3})-(\d{1,3})-(\d{1,3})\.local\.eca\.dev$/i;

const SSLIP_DOMAIN = 'local.eca.dev';

/**
 * Extract the embedded IP from an sslip.io-style hostname.
 * E.g. "192-168-15-17.local.eca.dev" → "192.168.15.17"
 * Returns undefined if the hostname doesn't match.
 */
export function extractSslipIp(host: string): string | undefined {
  const match = SSLIP_LOCAL_RE.exec(host);
  if (!match) return undefined;
  return `${match[1]}.${match[2]}.${match[3]}.${match[4]}`;
}

/**
 * Convert a raw IP to its sslip.io-style hostname under local.eca.dev.
 * E.g. "192.168.15.17" → "192-168-15-17.local.eca.dev"
 *
 * If `hostWithPort` contains a port (e.g. "192.168.1.42:7777"), the port
 * is preserved: "192-168-1-42.local.eca.dev:7777".
 *
 * Returns the input unchanged if it's not a raw IPv4 address.
 */
export function ipToSslipHostname(hostWithPort: string): string {
  const [hostPart, port] = hostWithPort.split(':');
  if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostPart)) return hostWithPort;
  const sslipHost = `${hostPart.replace(/\./g, '-')}.${SSLIP_DOMAIN}`;
  return port ? `${sslipHost}:${port}` : sslipHost;
}

/**
 * True when `host` is a raw private/loopback IPv4 (not already an sslip hostname).
 * Useful to decide whether to transform a user-entered host to sslip form.
 */
export function isRawPrivateIp(host: string): boolean {
  const hostPart = host.split(':')[0];
  return (PRIVATE_NETWORK_RE.test(hostPart) || LOOPBACK_RE.test(hostPart))
    && !SSLIP_LOCAL_RE.test(hostPart);
}

/**
 * Returns true when `host` targets a private/local network address.
 * Also recognises sslip.io-style hostnames under *.local.eca.dev
 * that embed a private IP (e.g. 192-168-15-17.local.eca.dev).
 * Used for protocol defaults and Chrome Local Network Access hints.
 */
export function isLocalNetworkHost(host: string): boolean {
  const resolved = extractSslipIp(host) ?? host;
  return PRIVATE_NETWORK_RE.test(resolved) || LOOPBACK_RE.test(resolved);
}

/**
 * Chrome LNA `targetAddressSpace` value for a given host.
 *
 * The fetch spec defines three address spaces:
 * - `"local"` — loopback (127.x, localhost)
 * - `"private"` — RFC 1918 (10.x, 172.16-31.x, 192.168.x)
 * - `undefined` — public / not applicable
 *
 * Also handles sslip.io-style *.local.eca.dev hostnames by extracting
 * the embedded IP before classification.
 *
 * Chrome validates that the resolved IP matches the declared space;
 * a mismatch causes the request to fail.
 */
export function targetAddressSpace(host: string): string | undefined {
  const resolved = extractSslipIp(host) ?? host;
  if (LOOPBACK_RE.test(resolved)) return 'local';
  if (PRIVATE_NETWORK_RE.test(resolved)) return 'private';
  return undefined;
}

/**
 * Resolve the HTTP protocol for a given host string.
 * When an explicit protocol is provided it is used as-is;
 * otherwise defaults to HTTPS (ECA servers support TLS for private IPs
 * via *.local.eca.dev wildcard certs).
 */
export function resolveProtocol(host: string, protocol?: Protocol): Protocol {
  if (protocol) return protocol;
  return 'https';
}

/**
 * Build the base API URL for a host, e.g. "https://myhost:7888/api/v1".
 *
 * When connecting over HTTPS to a raw private IP, automatically rewrites
 * the host to its sslip.io hostname so the TLS certificate matches.
 */
export function resolveBaseUrl(host: string, protocol?: Protocol): string {
  const proto = resolveProtocol(host, protocol);
  const effectiveHost = proto === 'https' && isRawPrivateIp(host)
    ? ipToSslipHostname(host)
    : host;
  return `${proto}://${effectiveHost}/api/v1`;
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
