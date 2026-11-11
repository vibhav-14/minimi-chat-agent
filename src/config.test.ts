import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, loadServerConfig } from './config.js';

const keys = { GEMINI_API_KEY: 'gemini-key', TAVILY_API_KEY: 'tavily-key' };

function configError(load: () => unknown): ConfigError {
  try {
    load();
  } catch (error) {
    if (error instanceof ConfigError) return error;
    throw error;
  }
  throw new Error('expected a ConfigError');
}

describe('loadConfig', () => {
  it('reads every variable from a complete env', () => {
    const config = loadConfig({
      ...keys,
      PORT: '8080',
      GEMINI_MODEL: 'gemini-3.6-flash',
      DATA_DIR: '/var/minimi',
      USER_TIMEZONE: 'Asia/Kolkata',
    });

    expect(config).toEqual({
      port: 8080,
      geminiApiKey: 'gemini-key',
      tavilyApiKey: 'tavily-key',
      geminiModel: 'gemini-3.6-flash',
      dataDir: '/var/minimi',
      userTimeZone: 'Asia/Kolkata',
    });
  });

  it('applies defaults when only the keys are set', () => {
    const config = loadConfig(keys);

    expect(config.port).toBe(3000);
    expect(config.geminiModel).toBe('gemini-3.8-flash');
    expect(config.dataDir).toBe('./data');
    // The system zone differs per machine; what matters is that one is always set.
    expect(config.userTimeZone).toMatch(/\S/);
  });

  // A quoted or shell-set key with spaces would otherwise fail later as an opaque auth error.
  it('trims surrounding spaces from values', () => {
    const config = loadConfig({ ...keys, GEMINI_API_KEY: ' gemini-key ' });

    expect(config.geminiApiKey).toBe('gemini-key');
  });

  // `KEY=` is what a user has after copying .env.example without filling it in.
  it.each([
    ['GEMINI_API_KEY', undefined],
    ['GEMINI_API_KEY', ''],
    ['TAVILY_API_KEY', undefined],
    ['TAVILY_API_KEY', '  '],
  ])('names %s as not set when it is %j', (name, value) => {
    const error = configError(() => loadConfig({ ...keys, [name]: value }));

    expect(error.message).toContain(`${name} is not set`);
    expect(error.message).toContain('.env.example');
  });

  it('lists every missing key in one error', () => {
    const error = configError(() => loadConfig({}));

    expect(error.message).toContain('GEMINI_API_KEY is not set');
    expect(error.message).toContain('TAVILY_API_KEY is not set');
  });

  it.each([
    ['PORT', 'http'],
    ['PORT', '70000'],
    ['USER_TIMEZONE', 'Mars/Olympus_Mons'],
  ])('rejects %s=%s as invalid', (name, value) => {
    const error = configError(() => loadConfig({ ...keys, [name]: value }));

    expect(error.message).toContain(`${name} is invalid`);
  });
});

describe('loadServerConfig', () => {
  it('starts without API keys so health and static files work', () => {
    expect(loadServerConfig({})).toEqual({ port: 3000 });
  });

  it('rejects an invalid PORT', () => {
    const error = configError(() => loadServerConfig({ PORT: '0' }));

    expect(error.message).toContain('PORT is invalid');
  });
});
