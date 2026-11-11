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

  return {
    async *stream(request) {
      try {
        const chunks = await client.generateContentStream(
          toGeminiRequest(request, options.model),
        );
        yield* toEvents(chunks);
      } catch (error) {
        // A cancelled turn is not a model failure: let the caller see its own abort.
        if (request.signal?.aborted) throw request.signal.reason;
        throw toLlmError(error);
      }
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
