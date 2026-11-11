// Reads the chat endpoint's server-sent events. EventSource cannot send a
// POST body, so the response is read with fetch and parsed here, following
// the event-stream format: field lines, events ended by a blank line.

/**
 * @typedef {object} SseMessage
 * @property {string} event The `event:` field, or "message" when absent.
 * @property {string} data Every `data:` line of the event, joined by "\n".
 */

/**
 * A parser that is fed text in arbitrary chunks and returns each complete
 * event once its terminating blank line has arrived. A chunk may end in the
 * middle of a line, or between the "\r" and "\n" of a line ending.
 */
export function createSseParser() {
  let buffer = '';
  let event = '';
  /** @type {string[]} */
  let data = [];

  /**
   * @param {string} line
   * @returns {SseMessage | null}
   */
  function readLine(line) {
    if (line === '') {
      const message =
        data.length > 0
          ? { event: event || 'message', data: data.join('\n') }
          : null;
      event = '';
      data = [];
      return message;
    }
    if (line.startsWith(':')) return null;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
    // id and retry are for EventSource reconnection, which a POST cannot use;
    // any other field is ignored, as the format requires.
    return null;
  }

  return {
    /**
     * @param {string} chunk
     * @returns {SseMessage[]}
     */
    push(chunk) {
      buffer += chunk;
      /** @type {SseMessage[]} */
      const messages = [];
      const ending = /\r\n|\r|\n/g;
      let start = 0;
      let match;
      while ((match = ending.exec(buffer))) {
        // A trailing "\r" may be the first half of "\r\n": wait for the next chunk.
        if (match[0] === '\r' && match.index === buffer.length - 1) break;
        const message = readLine(buffer.slice(start, match.index));
        if (message) messages.push(message);
        start = ending.lastIndex;
      }
      buffer = buffer.slice(start);
      return messages;
    },
  };
}

/** @typedef {import('./types.js').AgentEvent} AgentEvent */

/**
 * The agent event an SSE message carries, or null when its data is not a
 * JSON object whose `type` matches the event name.
 *
 * @param {SseMessage} message
 * @returns {AgentEvent | null}
 */
export function toAgentEvent(message) {
  /** @type {unknown} */
  let value;
  try {
    value = JSON.parse(message.data);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const event = /** @type {Record<string, unknown>} */ (value);
  if (event.type !== message.event) return null;
  return /** @type {AgentEvent} */ (event);
}

/**
 * Reads a server-sent event response body to its end, calling `onEvent` for
 * each well-formed agent event. Malformed events are skipped. An abort or a
 * network failure rejects with the reader's error.
 *
 * @param {ReadableStream<Uint8Array>} body
 * @param {(event: AgentEvent) => void} onEvent
 * @returns {Promise<void>}
 */
export async function readAgentEvents(body, onEvent) {
  const parser = createSseParser();
  // stream: true keeps a multi-byte character split across chunks intact.
  const decoder = new TextDecoder();
  const reader = body.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    for (const message of parser.push(
      decoder.decode(value, { stream: true }),
    )) {
      const event = toAgentEvent(message);
      if (event) onEvent(event);
      else console.warn('Skipped a malformed event:', message);
    }
  }
}
