import {
  ApiError,
  FinishReason as GeminiFinishReason,
  FunctionCallingConfigMode,
  GoogleGenAI,
  ThinkingLevel,
  type Candidate,
  type Content,
  type GenerateContentParameters,
  type Part,
} from '@google/genai';
import {
  LlmError,
  type FinishReason,
  type LlmEvent,
  type LlmMessage,
  type LlmProvider,
  type LlmRequest,
} from './types.js';

/** The part of the SDK the adapter uses, so tests can pass a scripted fake. */
export interface GeminiClient {
  generateContentStream(
    params: GenerateContentParameters,
  ): Promise<AsyncIterable<{ candidates?: Candidate[] }>>;
}

export interface GeminiOptions {
  apiKey: string;
  model: string;
  client?: GeminiClient;
}

/**
 * A step that has not produced its first chunk by now is not coming: on the
 * free tier a model was seen to accept the request and send 0 bytes for over
 * 40 s, while working models answered in 2 to 4 s.
 */
export const FIRST_CHUNK_TIMEOUT_MS = 30_000;
/** Cap on one whole step, so a stream that stalls after starting also ends. */
export const STEP_TIMEOUT_MS = 120_000;
/** Suggested in the timeout message: it answered fastest on the free tier. */
const FALLBACK_MODEL = 'gemini-3.5-flash-lite';

// Low is the least thinking gemini-3.8-flash accepts (it rejects `minimal`);
// the default is medium. A chat reply that mostly reads search results gains
// little from more, and every thinking token delays the first visible one.
const THINKING_LEVEL = ThinkingLevel.LOW;

/**
 * Gemini through `models.generateContentStream`, the stateless API: every
 * request carries the whole conversation. This app keeps its own history
 * (that is what memory is), so the Interactions API's server-side state
 * would be a second copy of it held by Google.
 */
export function createGeminiProvider(options: GeminiOptions): LlmProvider {
  const client =
    options.client ?? new GoogleGenAI({ apiKey: options.apiKey }).models;

  // The deadline lives here, not in the agent loop: only the adapter holds
  // the request it must abort, and the SDK sets no client-side timeout of its
  // own (it disables Node's fetch timeouts and relies on the server's 20
  // minute cap on a stream).
  return {
    async *stream(request) {
      const deadline = startDeadline(options.model, request.signal);
      try {
        const chunks = await deadline.race(
          client.generateContentStream(
            toGeminiRequest(
              { ...request, signal: deadline.signal },
              options.model,
            ),
          ),
        );
        yield* toEvents(deadline.guard(chunks));
      } catch (error) {
        // A cancelled turn is not a model failure: let the caller see its own abort.
        if (request.signal?.aborted) throw request.signal.reason;
        if (deadline.expired) throw deadline.signal.reason;
        throw toLlmError(error);
      } finally {
        deadline.clear();
      }
    },
  };
}

/**
 * Two timers for one step: the first chunk within FIRST_CHUNK_TIMEOUT_MS and
 * the whole step within STEP_TIMEOUT_MS. On expiry `signal` aborts with an
 * LlmError, which cancels the request. `race` and `guard` reject as soon as
 * `signal` aborts (expiry or the caller's abort), so the step ends even if
 * the stream never settles.
 */
function startDeadline(model: string, callerSignal: AbortSignal | undefined) {
  const timeout = new AbortController();
  const signal = callerSignal
    ? AbortSignal.any([callerSignal, timeout.signal])
    : timeout.signal;
  const expire = (ms: number, message: string) =>
    setTimeout(() => timeout.abort(new LlmError('timeout', message)), ms);
  const advice = `Try again, or set GEMINI_MODEL in .env to another model, such as ${FALLBACK_MODEL}.`;
  const firstChunk = expire(
    FIRST_CHUNK_TIMEOUT_MS,
    `The model ${model} did not respond within ${FIRST_CHUNK_TIMEOUT_MS / 1000} s. ${advice}`,
  );
  const step = expire(
    STEP_TIMEOUT_MS,
    `The model ${model} did not finish its answer within ${STEP_TIMEOUT_MS / 1000} s. ${advice}`,
  );
  const aborted = new Promise<never>((_, reject) => {
    const fail = () => reject(signal.reason as Error);
    if (signal.aborted) fail();
    else signal.addEventListener('abort', fail, { once: true });
  });
  // Only observed through race(); an abort with nothing pending is not an error.
  aborted.catch(() => undefined);
  const race = <T>(promise: Promise<T>) => Promise.race([promise, aborted]);

  return {
    signal,
    get expired() {
      return timeout.signal.aborted;
    },
    race,
    async *guard<T>(source: AsyncIterable<T>): AsyncGenerator<T> {
      const iterator = source[Symbol.asyncIterator]();
      for (;;) {
        const next = await race(iterator.next());
        clearTimeout(firstChunk);
        if (next.done) return;
        yield next.value;
      }
    },
    clear() {
      clearTimeout(firstChunk);
      clearTimeout(step);
    },
  };
}

export function toGeminiRequest(
  request: LlmRequest,
  model: string,
): GenerateContentParameters {
  return {
    model,
    contents: mergeTurns(request.messages.map(toContent)),
    config: {
      systemInstruction: request.system,
      tools:
        request.tools.length > 0
          ? [
              {
                functionDeclarations: request.tools.map((tool) => ({
                  name: tool.name,
                  description: tool.description,
                  parametersJsonSchema: tool.parameters,
                })),
              },
            ]
          : undefined,
      toolConfig:
        request.toolChoice === 'none'
          ? { functionCallingConfig: { mode: FunctionCallingConfigMode.NONE } }
          : undefined,
      thinkingConfig: { thinkingLevel: THINKING_LEVEL },
      abortSignal: request.signal,
    },
  };
}

function toContent(message: LlmMessage): Content {
  switch (message.role) {
    case 'user':
      return { role: 'user', parts: [{ text: message.text }] };
    case 'assistant': {
      const parts: Part[] = message.text ? [{ text: message.text }] : [];
      for (const call of message.toolCalls) {
        parts.push({
          functionCall: {
            id: call.id,
            name: call.name,
            args: isRecord(call.args) ? call.args : {},
          },
          // Gemini 3 rejects a replayed function call without its signature.
          ...(call.signature && { thoughtSignature: call.signature }),
        });
      }
      return { role: 'model', parts };
    }
    case 'tool':
      return {
        role: 'user',
        parts: message.results.map((result) => ({
          functionResponse: {
            id: result.callId,
            name: result.name,
            response: result.isError
              ? { error: result.content }
              : { output: result.content },
          },
        })),
      };
  }
}

/**
 * Joins neighbouring contents of the same role into one. The agent sends the
 * context block and the user's message as separate user messages, and a
 * final-step note after the tool results; Gemini's documented turns alternate
 * between user and model, so each run of one role becomes one turn.
 */
function mergeTurns(contents: Content[]): Content[] {
  const merged: Content[] = [];
  for (const content of contents) {
    const last = merged.at(-1);
    if (last && last.role === content.role) {
      last.parts = [...(last.parts ?? []), ...(content.parts ?? [])];
    } else {
      merged.push({ ...content, parts: [...(content.parts ?? [])] });
    }
  }
  return merged;
}

async function* toEvents(
  chunks: AsyncIterable<{ candidates?: Candidate[] }>,
): AsyncGenerator<LlmEvent> {
  let finish: FinishReason = 'stop';
  let calls = 0;
  for await (const chunk of chunks) {
    const candidate = chunk.candidates?.[0];
    for (const part of candidate?.content?.parts ?? []) {
      // Thought summaries are only sent when asked for; skip them if they appear.
      if (part.text && !part.thought) yield { type: 'text', text: part.text };
      if (part.functionCall) {
        calls++;
        yield {
          type: 'tool_call',
          call: {
            // The Gemini API may leave the id out; the loop needs one to pair results.
            id: part.functionCall.id ?? `call_${calls}`,
            name: part.functionCall.name ?? '',
            args: part.functionCall.args ?? {},
            ...(part.thoughtSignature && { signature: part.thoughtSignature }),
          },
        };
      }
    }
    if (candidate?.finishReason)
      finish = toFinishReason(candidate.finishReason);
  }
  yield { type: 'finish', reason: finish };
}

function toFinishReason(reason: GeminiFinishReason): FinishReason {
  switch (reason) {
    case GeminiFinishReason.STOP:
      return 'stop';
    case GeminiFinishReason.MAX_TOKENS:
      return 'max_tokens';
    case GeminiFinishReason.SAFETY:
    case GeminiFinishReason.RECITATION:
    case GeminiFinishReason.BLOCKLIST:
    case GeminiFinishReason.PROHIBITED_CONTENT:
    case GeminiFinishReason.SPII:
      return 'blocked';
    default:
      return 'other';
  }
}

/**
 * Gemini answers 429 for both a per-minute limit and a used-up daily quota;
 * only the quota ID in the body tells them apart (for example
 * "GenerateRequestsPerDayPerProjectPerModel-FreeTier").
 */
export function toLlmError(error: unknown): LlmError {
  if (!(error instanceof ApiError)) {
    return new LlmError(
      'other',
      `Could not reach Gemini: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const detail = apiMessage(error.message);
  const { status } = error;
  // An invalid key comes back as 400 INVALID_ARGUMENT, not 401.
  if (status === 401 || status === 403 || /API key not valid/i.test(detail)) {
    return new LlmError(
      'auth',
      `Gemini rejected the API key (HTTP ${status}). Check GEMINI_API_KEY in .env.`,
      { cause: error },
    );
  }
  if (status === 429) {
    return /PerDay/i.test(error.message)
      ? new LlmError('quota', `The Gemini daily quota is used up: ${detail}`, {
          cause: error,
        })
      : new LlmError(
          'rate_limit',
          `Gemini is rate limiting requests: ${detail}`,
          { cause: error },
        );
  }
  if (status === 404) {
    return new LlmError(
      'other',
      `Gemini does not know this model (HTTP 404). Check GEMINI_MODEL in .env: ${detail}`,
      { cause: error },
    );
  }
  return new LlmError(
    'other',
    `Gemini request failed (HTTP ${status}): ${detail}`,
    { cause: error },
  );
}

/** The SDK puts the raw JSON error body in the message; pull out its readable part. */
function apiMessage(raw: string): string {
  try {
    const body: unknown = JSON.parse(raw);
    if (isRecord(body) && isRecord(body.error)) {
      const { message } = body.error;
      if (typeof message === 'string') return message;
    }
  } catch {
    // Not JSON: the raw text is the message.
  }
  return raw;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
