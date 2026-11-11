import { z } from 'zod';
import {
  DEFAULT_SEARCH_DEPTH,
  tavilySearchDepths,
  type TavilySearchDepth,
} from './search/tavily.js';

const DEFAULT_PORT = 3000;
const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash';
const DEFAULT_DATA_DIR = './data';

function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

const serverSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(DEFAULT_PORT),
});

const searchSchema = z.object({
  TAVILY_API_KEY: z.string(),
  TAVILY_SEARCH_DEPTH: z.enum(tavilySearchDepths).default(DEFAULT_SEARCH_DEPTH),
});

const appSchema = serverSchema.extend({
  ...searchSchema.shape,
  GEMINI_API_KEY: z.string(),
  GEMINI_MODEL: z.string().default(DEFAULT_GEMINI_MODEL),
  DATA_DIR: z.string().default(DEFAULT_DATA_DIR),
  USER_TIMEZONE: z
    .string()
    .refine(isTimeZone, 'must be an IANA time zone such as Europe/London')
    .optional(),
});

export type Env = Readonly<Record<string, string | undefined>>;

export interface ServerConfig {
  port: number;
}

export interface SearchConfig {
  tavilyApiKey: string;
  tavilySearchDepth: TavilySearchDepth;
}

export interface AppConfig extends ServerConfig, SearchConfig {
  geminiApiKey: string;
  geminiModel: string;
  dataDir: string;
  userTimeZone: string;
}

/** Thrown with a message meant to be printed as is, without a stack trace. */
export class ConfigError extends Error {
  override name = 'ConfigError';
}

/** Settings the HTTP server needs. Works without API keys. */
export function loadServerConfig(env: Env): ServerConfig {
  const parsed = parse(serverSchema, env);
  return { port: parsed.PORT };
}

/** Settings for web search alone, for scripts that do not need the model. */
export function loadSearchConfig(env: Env): SearchConfig {
  const parsed = parse(searchSchema, env);
  return {
    tavilyApiKey: parsed.TAVILY_API_KEY,
    tavilySearchDepth: parsed.TAVILY_SEARCH_DEPTH,
  };
}

/** Full settings for the agent. Throws ConfigError if a key is missing or a value is invalid. */
export function loadConfig(env: Env): AppConfig {
  const parsed = parse(appSchema, env);
  return {
    port: parsed.PORT,
    geminiApiKey: parsed.GEMINI_API_KEY,
    tavilyApiKey: parsed.TAVILY_API_KEY,
    tavilySearchDepth: parsed.TAVILY_SEARCH_DEPTH,
    geminiModel: parsed.GEMINI_MODEL,
    dataDir: parsed.DATA_DIR,
    userTimeZone:
      parsed.USER_TIMEZONE ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}

function parse<T extends z.ZodType>(schema: T, env: Env): z.infer<T> {
  // Trimmed so a stray space never reaches an API as part of a key, and a
  // line like `GEMINI_API_KEY=` copied from .env.example means "not set".
  const present = Object.fromEntries(
    Object.entries(env)
      .map(([name, value]) => [name, value?.trim()] as const)
      .filter(([, value]) => value),
  );
  const result = schema.safeParse(present);
  if (result.success) return result.data;

  const problems = result.error.issues.map((issue) => {
    const name = String(issue.path[0]);
    return name in present
      ? `${name} is invalid: ${issue.message}`
      : `${name} is not set`;
  });
  throw new ConfigError(
    [
      'Configuration error:',
      ...problems.map((problem) => `  - ${problem}`),
      'Copy .env.example to .env and fill in the values; it says where to get each key.',
    ].join('\n'),
  );
}
