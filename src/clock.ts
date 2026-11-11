/** Source of the current time. Injected so date logic can be tested at a fixed instant. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

export function fixedClock(date: Date): Clock {
  const instant = date.getTime();
  // A fresh Date per call, so a caller mutating the result cannot move the clock.
  return { now: () => new Date(instant) };
}
