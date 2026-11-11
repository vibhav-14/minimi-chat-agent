/** A tool the model may call: a name, guidance for the model, and a JSON Schema for its arguments. */
export interface ToolDeclaration {
  name: string;
  description: string;
  parameters: unknown;
}

export interface ToolCall {
  id: string;
  name: string;
  args: unknown;
  /**
   * Opaque data the provider attached to the call and needs back when the
   * call is replayed in the next request. Never read outside the adapter.
   */
  signature?: string;
}

export interface ToolResult {
  callId: string;
  name: string;
  content: string;
  /** The call could not run (unknown tool); the model should correct itself. */
  isError?: boolean;
}

export type LlmMessage =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text: string; toolCalls: ToolCall[] }
  | { role: 'tool'; results: ToolResult[] };

export interface LlmRequest {
  system: string;
  messages: LlmMessage[];
  tools: ToolDeclaration[];
  /** `none` forbids tool calls, so the model must answer with text. */
  toolChoice?: 'auto' | 'none';
  signal?: AbortSignal;
}

export type FinishReason = 'stop' | 'max_tokens' | 'blocked' | 'other';

export type LlmEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'finish'; reason: FinishReason };

/** A chat model. The agent depends on this, never on a vendor SDK. */
export interface LlmProvider {
  /**
   * Streams one model step. Ends with a `finish` event; throws LlmError
   * (including `timeout` when the model does not answer in time) or the
   * caller's abort.
   */
  stream(request: LlmRequest): AsyncIterable<LlmEvent>;
}

/**
 * Why a model call failed, so the user can be told something useful:
 * `rate_limit` may succeed shortly, `quota` and `auth` will not, and
 * `timeout` means the model did not answer in time.
 */
export type LlmErrorKind =
  'auth' | 'rate_limit' | 'quota' | 'timeout' | 'other';

export class LlmError extends Error {
  override name = 'LlmError';

  constructor(
    readonly kind: LlmErrorKind,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}
