/**
 * Shared utility functions for the bridge layer.
 *
 * Centralizes protocol resolution and HTTP helpers so that
 * api.ts, transport.ts, and connection-testing code all
 * use the same logic.
 */

/**
 * Resolve the HTTP protocol for a given host string.
 * Localhost / 127.0.0.1 → http, everything else → https.
 */
export function resolveProtocol(host: string): 'http' | 'https' {
  if (host.startsWith('localhost') || host.startsWith('127.0.0.1')) {
    return 'http';
  }
  return 'https';
}

/**
 * Build the base API URL for a host, e.g. "https://myhost:7888/api/v1".
 */
export function resolveBaseUrl(host: string): string {
  return `${resolveProtocol(host)}://${host}/api/v1`;
}

/**
 * Fetch with an abort-based timeout.
 *
 * Wraps the standard `fetch` and aborts the request if it exceeds
 * `timeoutMs` milliseconds. The AbortError can be caught upstream
 * to show a user-friendly timeout message.
 */
export async function fetchWithTimeout(
  url: string,
  init?: RequestInit,
  timeoutMs = 10_000,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
