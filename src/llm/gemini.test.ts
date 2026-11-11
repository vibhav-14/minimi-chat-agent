import {
  ApiError,
  FinishReason,
  FunctionCallingConfigMode,
  type Candidate,
  type GenerateContentParameters,
} from '@google/genai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createGeminiProvider,
  FIRST_CHUNK_TIMEOUT_MS,
  STEP_TIMEOUT_MS,
  toGeminiRequest,
  type GeminiClient,
} from './gemini.js';
import { LlmError, type LlmEvent, type LlmRequest } from './types.js';

type Chunk = { candidates?: Candidate[] };

/** A client that records the request and replays scripted chunks, or fails. */
function fakeClient(chunks: Chunk[] | Error) {
  const requests: GenerateContentParameters[] = [];
  return {
    requests,
    client: {
      generateContentStream(params: GenerateContentParameters) {
        requests.push(params);
        if (chunks instanceof Error) return Promise.reject(chunks);
        return Promise.resolve(
          (async function* () {
            for (const chunk of chunks) {
              await Promise.resolve();
              yield chunk;
            }
          })(),
        );
      },
    },
  };
}

const baseRequest: LlmRequest = {
  system: 'Be brief.',
  messages: [{ role: 'user', text: 'Hi' }],
  tools: [],
};

async function collect(
  chunks: Chunk[] | Error,
  request = baseRequest,
): Promise<LlmEvent[]> {
  const { client } = fakeClient(chunks);
  const provider = createGeminiProvider({ apiKey: 'k', model: 'm', client });
  const events: LlmEvent[] = [];
  for await (const event of provider.stream(request)) events.push(event);
  return events;
}

const chunk = (
  parts: NonNullable<Candidate['content']>['parts'],
  finishReason?: FinishReason,
): Chunk => ({
  candidates: [{ content: { role: 'model', parts }, finishReason }],
});

describe('toGeminiRequest', () => {
  it('maps a tool round trip to alternating contents with ids and signatures', () => {
    const request = toGeminiRequest(
      {
        system: 'System prompt.',
        messages: [
          { role: 'user', text: 'Context block.' },
          { role: 'user', text: 'Pipedrive and HubSpot prices?' },
          {
            role: 'assistant',
            text: 'Checking.',
            toolCalls: [
              {
                id: 'c1',
                name: 'web_search',
                args: { queries: ['Pipedrive pricing'] },
                signature: 'sig-1',
              },
              {
                id: 'c2',
                name: 'web_search',
                args: { queries: ['HubSpot pricing'] },
              },
            ],
          },
          {
            role: 'tool',
            results: [
              { callId: 'c1', name: 'web_search', content: 'results 1' },
              {
                callId: 'c2',
                name: 'nope',
                content: 'Unknown tool',
                isError: true,
              },
            ],
          },
          { role: 'user', text: 'Answer now.' },
        ],
        tools: [
          { name: 'web_search', description: 'Search.', parameters: { a: 1 } },
        ],
        toolChoice: 'none',
      },
      'gemini-3.8-flash',
    );

    expect(request.model).toBe('gemini-3.8-flash');
    expect(request.contents).toEqual([
      {
        role: 'user',
        parts: [
          { text: 'Context block.' },
          { text: 'Pipedrive and HubSpot prices?' },
        ],
      },
      {
        role: 'model',
        parts: [
          { text: 'Checking.' },
          {
            functionCall: {
              id: 'c1',
              name: 'web_search',
              args: { queries: ['Pipedrive pricing'] },
            },
            thoughtSignature: 'sig-1',
          },
          {
            functionCall: {
              id: 'c2',
              name: 'web_search',
              args: { queries: ['HubSpot pricing'] },
            },
          },
        ],
      },
      {
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: 'c1',
              name: 'web_search',
              response: { output: 'results 1' },
            },
          },
          {
            functionResponse: {
              id: 'c2',
              name: 'nope',
              response: { error: 'Unknown tool' },
            },
          },
          { text: 'Answer now.' },
        ],
      },
    ]);
    expect(request.config).toMatchObject({
      systemInstruction: 'System prompt.',
      tools: [
        {
          functionDeclarations: [
            {
              name: 'web_search',
              description: 'Search.',
              parametersJsonSchema: { a: 1 },
            },
          ],
        },
      ],
      toolConfig: {
        functionCallingConfig: { mode: FunctionCallingConfigMode.NONE },
      },
      thinkingConfig: { thinkingLevel: 'LOW' },
    });
  });

  it('declares no tools and no tool config when none are given', () => {
    const { config } = toGeminiRequest(baseRequest, 'm');
    expect(config?.tools).toBeUndefined();
    expect(config?.toolConfig).toBeUndefined();
  });
});

describe('createGeminiProvider stream', () => {
  it('streams text deltas and skips thought parts', async () => {
    const events = await collect([
      chunk([{ text: 'thinking', thought: true }, { text: 'Hel' }]),
      chunk([{ text: 'lo.' }], FinishReason.STOP),
    ]);

    expect(events).toEqual([
      { type: 'text', text: 'Hel' },
      { type: 'text', text: 'lo.' },
      { type: 'finish', reason: 'stop' },
    ]);
  });

  // Parallel calls arrive as several parts; each needs an id to pair with its result.
  it('yields every function call of a step, keeping ids and signatures', async () => {
    const events = await collect([
      chunk([
        {
          functionCall: { name: 'web_search', args: { queries: ['a'] } },
          thoughtSignature: 'sig',
        },
        {
          functionCall: {
            id: 'x',
            name: 'web_search',
            args: { queries: ['b'] },
          },
        },
      ]),
    ]);

    expect(events).toEqual([
      {
        type: 'tool_call',
        call: {
          id: 'call_1',
          name: 'web_search',
          args: { queries: ['a'] },
          signature: 'sig',
        },
      },
      {
        type: 'tool_call',
        call: { id: 'x', name: 'web_search', args: { queries: ['b'] } },
      },
      { type: 'finish', reason: 'stop' },
    ]);
  });

  it.each([
    [FinishReason.MAX_TOKENS, 'max_tokens'],
    [FinishReason.SAFETY, 'blocked'],
    [FinishReason.MALFORMED_FUNCTION_CALL, 'other'],
  ])('maps finish reason %s to %s', async (reason, expected) => {
    const events = await collect([chunk([{ text: 'x' }], reason)]);
    expect(events.at(-1)).toEqual({ type: 'finish', reason: expected });
  });
});

describe('createGeminiProvider errors', () => {
  const apiError = (status: number, body: object) =>
    new ApiError({ status, message: JSON.stringify(body) });

  async function failure(error: Error): Promise<LlmError> {
    try {
      await collect(error);
    } catch (thrown) {
      if (thrown instanceof LlmError) return thrown;
      throw thrown;
    }
    throw new Error('expected an LlmError');
  }

  it.each([
    [
      'a 403',
      apiError(403, { error: { message: 'Permission denied' } }),
      'auth',
      'GEMINI_API_KEY',
    ],
    [
      'a 400 for an invalid key',
      apiError(400, {
        error: { message: 'API key not valid. Please pass a valid API key.' },
      }),
      'auth',
      'GEMINI_API_KEY',
    ],
    [
      'a per-minute 429',
      apiError(429, {
        error: {
          message: 'You exceeded your current quota.',
          details: [
            {
              violations: [
                {
                  quotaId:
                    'GenerateRequestsPerMinutePerProjectPerModel-FreeTier',
                },
              ],
            },
          ],
        },
      }),
      'rate_limit',
      'You exceeded your current quota.',
    ],
    [
      'a per-day 429',
      apiError(429, {
        error: {
          message: 'You exceeded your current quota.',
          details: [
            {
              violations: [
                {
                  quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier',
                },
              ],
            },
          ],
        },
      }),
      'quota',
      'daily quota',
    ],
    [
      'a 404 for an unknown model',
      apiError(404, { error: { message: 'models/x is not found' } }),
      'other',
      'GEMINI_MODEL',
    ],
    [
      'a network failure',
      new TypeError('fetch failed'),
      'other',
      'fetch failed',
    ],
  ])('maps %s to %s', async (_, error, kind, text) => {
    const thrown = await failure(error);
    expect(thrown.kind).toBe(kind);
    expect(thrown.message).toContain(text);
  });

  it('rethrows the caller abort rather than a model error', async () => {
    const controller = new AbortController();
    const reason = new Error('client left');
    controller.abort(reason);
    const { client } = fakeClient(new Error('request aborted'));
    const provider = createGeminiProvider({ apiKey: 'k', model: 'm', client });

    const run = async () => {
      for await (const event of provider.stream({
        ...baseRequest,
        signal: controller.signal,
      }))
        void event;
    };

    await expect(run()).rejects.toBe(reason);
  });
});

describe('createGeminiProvider deadlines', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** A client whose stream yields `chunks` and then never settles, ignoring any abort. */
  function stallingClient(chunks: Chunk[]) {
    const requests: GenerateContentParameters[] = [];
    const client = {
      generateContentStream(params: GenerateContentParameters) {
        requests.push(params);
        return Promise.resolve(
          (async function* () {
            yield* chunks;
            await new Promise(() => undefined);
          })(),
        );
      },
    };
    return { client, requests };
  }

  function start(client: GeminiClient, signal?: AbortSignal) {
    const provider = createGeminiProvider({
      apiKey: 'k',
      model: 'slow-model',
      client,
    });
    const events: LlmEvent[] = [];
    const done = (async () => {
      for await (const event of provider.stream({ ...baseRequest, signal }))
        events.push(event);
    })();
    // Settles the promise for later assertions without an unhandled rejection.
    done.catch(() => undefined);
    return { events, done };
  }

  // The live failure: the request is accepted and nothing ever arrives.
  it('ends a step with no first chunk with a timeout naming the fix, and aborts the request', async () => {
    const requests: GenerateContentParameters[] = [];
    const client = {
      generateContentStream(params: GenerateContentParameters) {
        requests.push(params);
        return new Promise<never>(() => undefined);
      },
    };
    const { done } = start(client);

    await vi.advanceTimersByTimeAsync(FIRST_CHUNK_TIMEOUT_MS - 1);
    expect(requests[0]?.config?.abortSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    const error = await done.then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(LlmError);
    expect(error).toMatchObject({ kind: 'timeout' });
    expect((error as LlmError).message).toMatch(
      /slow-model did not respond.*GEMINI_MODEL.*gemini-3\.5-flash-lite/,
    );
    expect(requests[0]?.config?.abortSignal?.aborted).toBe(true);
  });

  it('lets a started stream run past the first-chunk deadline but ends it at the step cap', async () => {
    const { client } = stallingClient([chunk([{ text: 'Partial' }])]);
    const { events, done } = start(client);

    await vi.advanceTimersByTimeAsync(FIRST_CHUNK_TIMEOUT_MS + 1);
    expect(events).toEqual([{ type: 'text', text: 'Partial' }]);
    await vi.advanceTimersByTimeAsync(STEP_TIMEOUT_MS);

    await expect(done).rejects.toMatchObject({
      kind: 'timeout',
      message: expect.stringContaining('did not finish') as string,
    });
  });

  it('throws the caller abort, not a timeout, even if the stream ignores it', async () => {
    const { client } = stallingClient([]);
    const controller = new AbortController();
    const reason = new Error('client left');
    const { done } = start(client, controller.signal);

    controller.abort(reason);

    await expect(done).rejects.toBe(reason);
  });

  it('leaves no timer running after a normal step', async () => {
    const { client } = fakeClient([chunk([{ text: 'Hi' }], FinishReason.STOP)]);
    const { events, done } = start(client);

    await done;

    expect(events.at(-1)).toEqual({ type: 'finish', reason: 'stop' });
    expect(vi.getTimerCount()).toBe(0);
  });
});
