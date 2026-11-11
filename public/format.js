// Display text for dates and activity. No DOM, so it is unit-tested.

/**
 * Formatting options default to the browser's locale and time zone; tests
 * pin both.
 *
 * @typedef {object} Locale
 * @property {string} [locale]
 * @property {string} [timeZone]
 */

/**
 * A message time with its date, because dates are what this app is about:
 * "Tue, 10 Nov 2026, 20:30" in the browser's zone and locale.
 *
 * @param {Date} date
 * @param {Locale} [options]
 */
export function formatTimestamp(date, { locale, timeZone } = {}) {
  return new Intl.DateTimeFormat(locale, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone,
  }).format(date);
}
