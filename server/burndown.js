// Derive best/worst sustained weekly burndown rates from a daily snapshot series.
// Pure (no I/O) so it's unit-testable.
//
// Primary signal is the week-over-week DECLINE in TotalRemaining (ADO maintains
// RemainingWork throughout, whereas historical CompletedWork snapshots are often
// backfilled to 0). Weeks where remaining INCREASED (scope added) are excluded
// from the sample. CompletedWork deltas are only a fallback when the remaining
// series is flat/unavailable.

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
 * @param series full daily [{ date, remaining, completed }]
 * @returns { computedBestRate, computedWorstRate, weeklyRates, weeklySeries }
 *          rates are null when not derivable. weeklySeries is the per-week
 *          diagnostic: [{ weekStart, remaining, completed, throughput, includedInSample }].
 */
export function computeWeeklyRates(series, opts = {}) {
  const lowPct = opts.lowPct ?? DEFAULT_LOW_PCT;
  const highPct = opts.highPct ?? DEFAULT_HIGH_PCT;
  const empty = { computedBestRate: null, computedWorstRate: null, weeklyRates: [], weeklySeries: [] };
  if (!Array.isArray(series) || series.length < 2) return empty;

  // Resample to weekly buckets: keep the last snapshot value in each ISO week.
  const byWeek = new Map();
  for (const p of series) {
    if (!p || !p.date) continue;
    const weekStart = isoWeekKey(p.date);
    const prev = byWeek.get(weekStart);
    if (!prev || p.date > prev.date) {
      byWeek.set(weekStart, {
        weekStart,
        date: p.date,
        completed: Number(p.completed) || 0,
        remaining: Number(p.remaining) || 0,
      });
    }
  }
  const weeks = [...byWeek.values()].sort((a, b) => (a.weekStart < b.weekStart ? -1 : 1));
  if (weeks.length < 2) return empty;

  // Sample uses all but the trailing partial (current) week.
  const lastIdx = weeks.length - 1;
  const usable = weeks.slice(0, lastIdx);
  const remainingRange =
    Math.max(...usable.map((w) => w.remaining)) - Math.min(...usable.map((w) => w.remaining));
  const usePrimary = remainingRange > 0; // remaining actually moves -> trust it

  const weeklySeries = weeks.map((w, i) => {
    let throughput = null;
    let includedInSample = false;
    if (i > 0 && i < lastIdx) {
      const prev = weeks[i - 1];
      if (usePrimary) {
        throughput = prev.remaining - w.remaining; // decline = work burned
        includedInSample = throughput >= 0; // exclude scope-add (remaining increased)
      } else {
        throughput = w.completed - prev.completed; // fallback
        includedInSample = true;
      }
    }
    return {
      weekStart: w.weekStart,
      remaining: Math.round(w.remaining),
      completed: Math.round(w.completed),
      throughput: throughput == null ? null : Math.round(throughput),
      includedInSample,
    };
  });

  const sample = weeklySeries.filter((w) => w.includedInSample).map((w) => w.throughput);
  if (sample.length === 0) return { ...empty, weeklySeries };

  const sorted = [...sample].sort((a, b) => a - b);
  return {
    computedWorstRate: Math.max(1, Math.round(percentile(sorted, lowPct))),
    computedBestRate: Math.max(1, Math.round(percentile(sorted, highPct))),
    weeklyRates: sample,
    weeklySeries,
  };
}
