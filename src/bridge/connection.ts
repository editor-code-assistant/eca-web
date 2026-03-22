/**
 * Connection testing — validates host reachability and authentication
 * before establishing a full WebBridge connection.
 *
 * This is used by the ConnectForm to provide fast, specific error
 * messages (wrong host? wrong password?) before attempting the heavier
 * SSE connection.
 */

import type { Protocol } from './utils';
import { fetchWithTimeout, isLocalNetworkHost, resolveBaseUrl } from './utils';

/**
 * Pre-request Chrome's Local Network Access (LNA) permission for a host.
 *
 * When `https://web.eca.dev` fetches a private IP, Chrome gates the
 * request behind a user permission prompt. This function triggers that
 * prompt **once** before port scanning so that all subsequent probes
 * succeed without blocking on user interaction.
 *
 * For non-local hosts this is a no-op.
 *
 * @returns true if the host is non-local or the LNA permission was granted.
 */
export async function requestLocalNetworkAccess(
  host: string,
  protocol: Protocol = 'http',
): Promise<boolean> {
  if (!isLocalNetworkHost(host)) return true;

  try {
    // Fire a single throwaway fetch to trigger the LNA prompt.
    // We use port 7777 (first discovery port) — the server may or may
    // not be there, but the prompt still fires for the hostname.
    // 30s timeout: user needs time to read and click "Allow".
    await fetchWithTimeout(
      `${protocol}://${host}:7777/api/v1/health`,
      undefined,
      30_000,
    );
    return true;
  } catch {
    // Even if this fetch fails (e.g. nothing on port 7777), the LNA
    // permission may still have been granted for the origin — Chrome
    // remembers the grant regardless of the HTTP outcome.
    return true;
  }
}

/**
 * Lightweight probe to check if an ECA server is listening on a given port.
 *
 * Used by auto-discovery to quickly scan a port range without requiring
 * full authentication.
 *
 * Tries both HTTP and HTTPS in parallel to handle protocol mismatches
 * (e.g. user selected HTTPS but server runs HTTP, or vice-versa).
 *
 * NOTE: Call {@link requestLocalNetworkAccess} once before scanning
 * so that Chrome's LNA permission is already granted and these fast
 * probes aren't blocked by the permission prompt.
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
      await fetchWithTimeout(url, undefined, 3_000);
    }),
  );
  return results.some((r) => r.status === 'fulfilled');
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
      return 'Connection timed out. Check the address and try again.';
    }
    return 'Could not reach host. Check the address and try again.';
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
