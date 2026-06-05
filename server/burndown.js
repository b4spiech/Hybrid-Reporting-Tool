// Derive best/worst sustained weekly burndown rates from a daily snapshot series.
// Pure (no I/O) so it's unit-testable.

const DEFAULT_LOW_PCT = 15; // slowest sustained pace -> worst rate
const DEFAULT_HIGH_PCT = 85; // fastest sustained pace -> best rate

/** Monday (UTC) of the date's ISO week, as YYYY-MM-DD. */
function isoWeekKey(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const dow = d.getUTCDay(); // 0 Sun .. 6 Sat
  d.setUTCDate(d.getUTCDate() - ((dow + 6) % 7));
  return d.toISOString().slice(0, 10);
}

function percentile(sortedAsc, p) {
  const idx = Math.round((p / 100) * (sortedAsc.length - 1));
  return sortedAsc[Math.max(0, Math.min(sortedAsc.length - 1, idx))];
}

/**
 * @param series full daily [{ date, remaining, completed }] (chronological-ish; sorted here)
 * @returns { computedBestRate, computedWorstRate, weeklyRates }  rates null when not derivable
 */
export function computeWeeklyRates(series, opts = {}) {
  const lowPct = opts.lowPct ?? DEFAULT_LOW_PCT;
  const highPct = opts.highPct ?? DEFAULT_HIGH_PCT;
  const empty = { computedBestRate: null, computedWorstRate: null, weeklyRates: [] };
  if (!Array.isArray(series) || series.length < 2) return empty;

  // (1) Resample to weekly buckets: keep the last snapshot value in each ISO week.
  const byWeek = new Map();
  for (const p of series) {
    if (!p || !p.date) continue;
    const wk = isoWeekKey(p.date);
    const prev = byWeek.get(wk);
    if (!prev || p.date > prev.date) {
      byWeek.set(wk, { date: p.date, completed: Number(p.completed) || 0, remaining: Number(p.remaining) || 0 });
    }
  }
  let weeks = [...byWeek.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([, v]) => v);
  // Drop the trailing partial (current) week.
  weeks = weeks.slice(0, -1);
  if (weeks.length < 2) return empty;

  // (2) Weekly throughput from consecutive weeks. If CompletedWork is flat/empty
  //     throughout (never populated), fall back to the drop in RemainingWork.
  const completedVals = weeks.map((w) => w.completed);
  const completedFlat = Math.max(...completedVals) - Math.min(...completedVals) <= 0;

  const throughputs = [];
  for (let i = 1; i < weeks.length; i++) {
    const t = completedFlat
      ? Math.max(0, weeks[i - 1].remaining - weeks[i].remaining)
      : weeks[i].completed - weeks[i - 1].completed;
    throughputs.push(t);
  }
  if (throughputs.length === 0) return empty;

  // (3) Percentile band -> worst (slow) / best (fast), whole hrs/wk, floored at 1.
  const sorted = [...throughputs].sort((a, b) => a - b);
  return {
    computedWorstRate: Math.max(1, Math.round(percentile(sorted, lowPct))),
    computedBestRate: Math.max(1, Math.round(percentile(sorted, highPct))),
    weeklyRates: throughputs.map((t) => Math.round(t)),
  };
}
