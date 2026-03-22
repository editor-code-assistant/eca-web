/**
 * Connection testing — validates host reachability and authentication
 * before establishing a full WebBridge connection.
 *
 * This is used by the ConnectForm to provide fast, specific error
 * messages (wrong host? wrong password?) before attempting the heavier
 * SSE connection.
 */

import type { Protocol } from './utils';
import { fetchWithTimeout, isLocalNetworkHost, resolveBaseUrl, resolveProtocol } from './utils';

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
function isMixedContentScenario(host: string, protocol?: Protocol): boolean {
  return globalThis.location?.protocol === 'https:'
    && resolveProtocol(host, protocol) === 'http'
    && isLocalNetworkHost(host);
}

const MIXED_CONTENT_HINT =
  'Your browser may be blocking this request (HTTPS → HTTP on a private network). '
  + 'Check that you\'ve allowed Local Network Access for this site in your browser settings.';

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
  const mixedContent = isMixedContentScenario(host, protocol);

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
      return mixedContent
        ? `Connection timed out. ${MIXED_CONTENT_HINT}`
        : 'Connection timed out. Check the address and try again.';
    }
    return mixedContent
      ? `Could not reach host. ${MIXED_CONTENT_HINT}`
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
