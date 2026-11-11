// Tests for the browser's event-stream reader (public/sse.js). They live
// under src/ so the existing Vitest and tsc setup runs them.
import { describe, expect, it, vi } from 'vitest';
import {
  createSseParser,
  readAgentEvents,
  toAgentEvent,
} from '../../public/sse.js';

/** Feeds every chunk to one parser and returns all events it produced. */
function parseAll(chunks: string[]) {
  const parser = createSseParser();
  return chunks.flatMap((chunk) => parser.push(chunk));
}

describe('createSseParser', () => {
  // The exact framing src/app.ts writes through Hono's writeSSE.
  const wire =
    'event: start\ndata: {"type":"start","conversationId":"c1","messageId":"m1"}\n\n' +
    'event: token\ndata: {"type":"token","text":"Hi"}\n\n';

  it('reads the events the server writes', () => {
    expect(parseAll([wire])).toEqual([
      {
        event: 'start',
        data: '{"type":"start","conversationId":"c1","messageId":"m1"}',
      },
      { event: 'token', data: '{"type":"token","text":"Hi"}' },
    ]);
  });

  // A network chunk can end anywhere; a lost or doubled event would garble the answer.
  it('gives the same events however the stream is split into chunks', () => {
    const whole = parseAll([wire]);
    for (let cut = 1; cut < wire.length; cut++) {
      expect(parseAll([wire.slice(0, cut), wire.slice(cut)])).toEqual(whole);
    }
    expect(parseAll([...wire])).toEqual(whole);
  });

  it.each([
    ['\\r\\n', '\r\n'],
    ['\\r', '\r'],
  ])('accepts %s line endings, even split between chunks', (_, eol) => {
    // A final "\r" only ends a line once the next character shows it is not
    // "\r\n", so a comment line follows the event.
    const text = `event: token${eol}data: a${eol}${eol}:${eol}`;

    expect(parseAll([text])).toEqual([{ event: 'token', data: 'a' }]);
    expect(parseAll([...text])).toEqual([{ event: 'token', data: 'a' }]);
  });

  it('joins multi-line data with newlines', () => {
    expect(parseAll(['event: x\ndata: one\ndata:two\ndata\n\n'])).toEqual([
      { event: 'x', data: 'one\ntwo\n' },
    ]);
  });

  it('waits for the blank line before emitting an event', () => {
    const parser = createSseParser();

    expect(parser.push('event: token\ndata: a\n')).toEqual([]);
    expect(parser.push('\n')).toEqual([{ event: 'token', data: 'a' }]);
  });

  it('skips comments, unknown fields and events without data', () => {
    const text =
      ': keep-alive\n\nid: 7\nretry: 10\nnonsense line\nevent: lonely\n\ndata: kept\n\n';

    expect(parseAll([text])).toEqual([{ event: 'message', data: 'kept' }]);
  });
});

describe('toAgentEvent', () => {
  it('returns the JSON event when its type matches the event name', () => {
    expect(
      toAgentEvent({ event: 'token', data: '{"type":"token","text":"a"}' }),
    ).toEqual({ type: 'token', text: 'a' });
  });

  it.each([
    ['data that is not JSON', 'token', '{"type":"tok'],
    ['JSON that is not an object', 'token', '"token"'],
    ['null', 'token', 'null'],
    ['a type that differs from the event name', 'done', '{"type":"token"}'],
  ])('rejects %s', (_, event, data) => {
    expect(toAgentEvent({ event, data })).toBeNull();
  });
});

describe('readAgentEvents', () => {
  function body(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
    return new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    });
  }

  // A character split between two network chunks must not turn into U+FFFD.
  it('decodes text split inside a multi-byte character', async () => {
    const bytes = new TextEncoder().encode(
      'event: token\ndata: {"type":"token","text":"€5"}\n\n',
    );
    const euro = bytes.indexOf(0xe2);
    const events: unknown[] = [];

    await readAgentEvents(
      body([bytes.slice(0, euro + 1), bytes.slice(euro + 1)]),
      (event) => events.push(event),
    );

    expect(events).toEqual([{ type: 'token', text: '€5' }]);
  });

  it('skips a malformed event and keeps reading', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const text =
      'event: token\ndata: {broken\n\nevent: done\ndata: {"type":"done","messageId":"m"}\n\n';
    const events: unknown[] = [];

    await readAgentEvents(body([new TextEncoder().encode(text)]), (event) =>
      events.push(event),
    );

    expect(events).toEqual([{ type: 'done', messageId: 'm' }]);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});
