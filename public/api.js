// The server's HTTP API, as the UI uses it.
import { readAgentEvents } from './sse.js';

/** @typedef {import('./types.js').AgentEvent} AgentEvent */

/** The server refused the request before any event was sent (a 400 or 404). */
export class ChatRequestError extends Error {}

/**
 * Sends one message and calls `onEvent` for each event of the turn, until
 * the server closes the stream. Aborting `signal` closes the connection,
 * which stops the turn on the server.
 *
 * @param {{ conversationId?: string, message: string, timeZone: string }} body
 * @param {AbortSignal} signal
 * @param {(event: AgentEvent) => void} onEvent
 * @returns {Promise<void>}
 */
export async function streamChat(body, signal, onEvent) {
  const response = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  const isStream = response.headers
    .get('content-type')
    ?.includes('text/event-stream');
  if (!response.ok || !isStream || !response.body) {
    throw new ChatRequestError(await errorMessage(response));
  }
  await readAgentEvents(response.body, onEvent);
}

/**
 * The `error` field of a JSON error response, or a generic line.
 *
 * @param {Response} response
 * @returns {Promise<string>}
 */
async function errorMessage(response) {
  try {
    const body = /** @type {unknown} */ (await response.json());
    if (typeof body === 'object' && body !== null && 'error' in body) {
      if (typeof body.error === 'string') return body.error;
    }
  } catch {
    // Not JSON: fall through to the status line.
  }
  return `The server answered ${response.status} ${response.statusText}.`;
}
