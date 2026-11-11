import { describe, expect, it } from 'vitest';
import { fixedClock } from './clock.js';

describe('fixedClock', () => {
  const instant = '2026-11-03T09:30:00.000Z';

  it('returns the same instant on every call', () => {
    const clock = fixedClock(new Date(instant));

    expect(clock.now().toISOString()).toBe(instant);
    expect(clock.now().toISOString()).toBe(instant);
  });

  it('is not moved by mutating a returned date or the original', () => {
    const original = new Date(instant);
    const clock = fixedClock(original);

    clock.now().setUTCFullYear(2000);
    original.setUTCFullYear(2000);

    expect(clock.now().toISOString()).toBe(instant);
  });
});
