// Date-only helpers. We treat every date as UTC midnight to avoid timezone
// drift (a "day" is a calendar day, not a moment in local time).

export const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Parse an ISO `YYYY-MM-DD` (or full ISO) string to a UTC-midnight Date. */
export function parseISO(iso: string): Date {
  // Take only the date portion so any time/zone suffix is ignored.
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, (m ?? 1) - 1, d ?? 1));
}

/** Format a Date as `YYYY-MM-DD` (UTC). */
export function toISO(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * MS_PER_DAY);
}

/** Whole-day difference a - b (positive when a is after b). */
export function diffDays(a: Date, b: Date): number {
  return Math.round((a.getTime() - b.getTime()) / MS_PER_DAY);
}

/** Today as a UTC-midnight Date. */
export function todayUTC(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
}

const DISPLAY = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  timeZone: 'UTC',
});

/** "Jun 2, 2026" */
export function formatDisplay(date: Date): string {
  return DISPLAY.format(date);
}

const SHORT = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
});

/** "Jun 2" */
export function formatShort(date: Date): string {
  return SHORT.format(date);
}

/**
 * The last Friday on or before `date`. JS getUTCDay(): Sun=0..Sat=6, Fri=5.
 */
export function lastFridayOnOrBefore(date: Date): Date {
  const dow = date.getUTCDay();
  const back = (dow - 5 + 7) % 7; // days to step back to reach Friday
  return addDays(date, -back);
}
