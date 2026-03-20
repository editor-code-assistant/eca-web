/**
 * Connection testing — validates host reachability and authentication
 * before establishing a full WebBridge connection.
 *
 * This is used by the ConnectForm to provide fast, specific error
 * messages (wrong host? wrong password?) before attempting the heavier
 * SSE connection.
 */

import { fetchWithTimeout, resolveBaseUrl } from './utils';

/**
 * Test whether a host is reachable and the password is valid.
 *
 * Returns a human-readable error message on failure, or null on success.
 * Performs two sequential checks:
 * 1. Health endpoint (unauthenticated) — tests reachability
 * 2. Session endpoint (authenticated) — tests credentials
 */
export async function testConnection(host: string, password: string): Promise<string | null> {
  const baseUrl = resolveBaseUrl(host);

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
