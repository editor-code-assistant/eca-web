/**
 * Connection testing — validates host reachability and authentication
 * before establishing a full WebBridge connection.
 *
 * This is used by the ConnectForm to provide fast, specific error
 * messages (wrong host? wrong password?) before attempting the heavier
 * SSE connection.
 */

import type { BrowserKind, Protocol } from './utils';
import { detectBrowser, fetchWithTimeout, isLocalNetworkHost, resolveBaseUrl, resolveProtocol } from './utils';

/**
 * Lightweight probe to check if an ECA server is listening on a given port.
 *
 * Used by auto-discovery to quickly scan a port range without requiring
 * full authentication. Uses `mode: 'no-cors'` so we only need to know
 * "is something responding?" — the opaque response is fine for discovery.
 *
 * Tries both HTTP and HTTPS in parallel to handle protocol mismatches
 * (e.g. user selected HTTPS but server runs HTTP, or vice-versa).
 */
export async function probePort(
  host: string,
  port: number,
  preferredProtocol: Protocol = 'http',
): Promise<boolean> {
  const protocols: Protocol[] =
    preferredProtocol === 'https' ? ['https', 'http'] : ['http', 'https'];

  const results = await Promise.allSettled(
    protocols.map(async (proto) => {
      const url = `${proto}://${host}:${port}/api/v1/health`;
      await fetchWithTimeout(url, { mode: 'no-cors' }, 3_000);
    }),
  );
  return results.some((r) => r.status === 'fulfilled');
}

/** True when the page is served over HTTPS and the target is plain HTTP on a private IP. */
export function isMixedContentScenario(host: string, protocol?: Protocol): boolean {
  return globalThis.location?.protocol === 'https:'
    && resolveProtocol(host, protocol) === 'http'
    && isLocalNetworkHost(host);
}

/**
 * Return a browser-specific explanation for mixed-content failures.
 *
 * Chrome's `targetAddressSpace` triggers its own Local Network Access
 * prompt, so it gets a short nudge.  Firefox and Safari have **no**
 * programmatic escape hatch — the only realistic options are switching
 * to a Chromium-based browser or running eca-web locally over HTTP.
 */
function mixedContentHintFor(browser: BrowserKind): string {
  switch (browser) {
    case 'chrome':
      return 'Allow the Local Network Access prompt in your browser, then retry.';
    case 'firefox':
      return 'Firefox blocks HTTPS pages from connecting to private HTTP servers (mixed active content). '
        + 'Use a Chromium-based browser (Chrome, Edge, Brave) or host eca-web locally over HTTP.';
    case 'safari':
      return 'Safari blocks HTTPS pages from connecting to private HTTP servers. '
        + 'Use a Chromium-based browser (Chrome, Edge, Brave) or host eca-web locally over HTTP.';
    default:
      return 'Your browser may be blocking this request (HTTPS → HTTP on a private network). '
        + 'Try a Chromium-based browser (Chrome, Edge, Brave) or host eca-web locally over HTTP.';
  }
}

/**
 * Proactive mixed-content warning for the ConnectForm.
 *
 * Returns a user-facing hint string when the host/protocol combination
 * will trigger mixed-content blocking, or `null` when no warning is
 * needed (page served over HTTP, target is public, or Chrome which
 * handles it via the LNA prompt automatically).
 */
export function getMixedContentWarning(host: string, protocol?: Protocol): string | null {
  if (!isMixedContentScenario(host, protocol)) return null;
  const browser = detectBrowser();
  // Chrome handles this via targetAddressSpace + LNA prompt — no warning needed
  if (browser === 'chrome') return null;
  return mixedContentHintFor(browser);
}

/**
 * Check whether a connection error is likely caused by mixed-content
 * blocking and return a helpful hint, or `null` if unrelated.
 *
 * Used by RemoteSession to decorate post-connect errors (e.g. Safari's
 * `TypeError` when the SSE fetch is silently blocked).
 */
export function getMixedContentErrorHint(host: string, protocol?: Protocol): string | null {
  if (!isMixedContentScenario(host, protocol)) return null;
  return mixedContentHintFor(detectBrowser());
}

/**
 * Test whether a host is reachable and the password is valid.
 *
 * Returns a human-readable error message on failure, or null on success.
 * Performs two sequential checks:
 * 1. Health endpoint (unauthenticated) — tests reachability
 * 2. Session endpoint (authenticated) — tests credentials
 */
export async function testConnection(host: string, password: string, protocol?: Protocol): Promise<string | null> {
  const baseUrl = resolveBaseUrl(host, protocol);
  const mixedContentHint = getMixedContentErrorHint(host, protocol);

  // 1. Test host reachability (health endpoint — no auth)
  try {
    const res = await fetchWithTimeout(`${baseUrl}/health`);
    if (!res.ok) {
      return res.status === 404
        ? 'No ECA server found at this address.'
        : `Host returned an error (${res.status}).`;
    }
  } catch (err: any) {
    if (err.name === 'AbortError') {
      return mixedContentHint
        ? `Connection timed out. ${mixedContentHint}`
        : 'Connection timed out. Check the address and try again.';
    }
    return mixedContentHint
      ? `Could not reach host. ${mixedContentHint}`
      : 'Could not reach host. Check the address and try again.';
  }

  // 2. Test authentication (session endpoint — requires auth)
  try {
    const res = await fetchWithTimeout(`${baseUrl}/session`, {
      headers: { 'Authorization': `Bearer ${password}` },
    });
    if (!res.ok) {
      return (res.status === 401 || res.status === 403)
        ? 'Authentication failed. Check your password.'
        : `Session check failed (${res.status}).`;
    }
  } catch (err: any) {
    if (err.name === 'AbortError') {
      return 'Authentication check timed out.';
    }
    return 'Authentication check failed.';
  }

  return null;
}
