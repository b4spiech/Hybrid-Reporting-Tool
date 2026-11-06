import { useEffect, useState } from 'react';
import type { Project } from '../types';
import { parseISO, formatShort, formatDisplay, addDays, diffDays } from '../dates';
import { computeSprints } from '../sprints';
import { observedRate as computeObservedRate } from '../risk';

type Point = { date: string; remaining: number; completed: number; scope: number };
type BurndownData = {
  start: string | null;
  end: string;
  plannedEnd: string | null;
  initialRemaining: number;
  points: Point[];
  // Weekly declines in remaining hours (completed weeks; scope-add weeks excluded).
  weeklyRates?: number[];
};

type Props = {
  project: Project;
  today: Date;
  onBack: () => void;
};

const COL = {
  actual: '#185FA5',
  trend: '#9aa7b5',
  best: '#3B6D11', // same green/red as the Schedule risk page
  worst: '#A32D2D',
  scope: '#85B7EB',
  today: '#33475b',
  grid: '#e3eaf3',
  axis: '#5a6b80',
};

// Plot geometry (intrinsic SVG units).
const W = 760;
const H = 320;
const ML = 56;
const MR = 18;
const MT = 16;
const MB = 42;
const PLOT_W = W - ML - MR;
const PLOT_H = H - MT - MB;
const Y_BASE = MT + PLOT_H;
// Cap how far the trend line may stretch the axis (a near-zero rate would
// otherwise push the finish years out and squash the history).
const MAX_PROJECTION_DAYS = 104 * 7;

export function BurndownPage({ project, today, onBack }: Props) {
  const [data, setData] = useState<BurndownData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showScope, setShowScope] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    fetch(`/api/projects/${project.id}/burndown`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: BurndownData) => {
        if (alive) {
          setData(d);
          setLoading(false);
        }
      })
      .catch(() => {
        if (alive) {
          setError('Could not load burndown data.');
          setLoading(false);
        }
      });
    return () => {
      alive = false;
    };
  }, [project.id]);

  const head = (
    <div className="risk-head">
      <button className="link" onClick={onBack}>
        ← Back to chart
      </button>
      <h2>Burndown — {project.name}</h2>
    </div>
  );

  if (loading) return <div className="risk-page">{head}<div className="loading">Loading…</div></div>;
  if (error) return <div className="risk-page">{head}<div className="risk-sentence">{error}</div></div>;

  const points = data?.points ?? [];
  if (!data || points.length < 2) {
    return (
      <div className="risk-page">
        {head}
        <div className="chart-card">
          <p style={{ color: COL.axis, margin: 0 }}>Not enough snapshot history yet.</p>
        </div>
      </div>
    );
  }

  const start = parseISO(data.start ?? points[0].date);
  const end = parseISO(data.end);
  const plannedEnd = data.plannedEnd ? parseISO(data.plannedEnd) : null;

  const last = points[points.length - 1];
  const remaining = last.remaining;
  const completed = last.completed;
  const pct = completed + remaining > 0 ? Math.round((completed / (completed + remaining)) * 100) : 0;

  // Trend: project from the latest snapshot at the observed rate (completed
  // hours ÷ sprints elapsed — the same number the Schedule risk page shows).
  // Fallback (before Sprint 1): average weekly decline in remaining.
  const historicalStart = project.risk?.historicalStart ? parseISO(project.risk.historicalStart) : undefined;
  const observed = computeObservedRate(
    project.totalCompletedHrs ?? completed,
    computeSprints(project.sprints),
    today,
    historicalStart,
  );
  const weeklyRates = data.weeklyRates ?? [];
  const avgRate = observed
    ? observed.perWeek
    : weeklyRates.length
      ? weeklyRates.reduce((a, b) => a + b, 0) / weeklyRates.length
      : null;
  const rateBasis = observed
    ? `observed (${observed.sprintsElapsed} sprint${observed.sprintsElapsed === 1 ? '' : 's'})`
    : 'avg burn';
  const anchor = parseISO(last.date);

  /** Project remaining forward at `rate` hrs/wk: finish date + where the drawn line stops (capped). */
  const projectAt = (rate: number | null | undefined) => {
    if (remaining <= 0) return { finish: anchor, end: null };
    if (!rate || rate <= 0) return { finish: null, end: null };
    const days = Math.round((remaining / rate) * 7);
    const finish = addDays(anchor, days);
    const end =
      days <= MAX_PROJECTION_DAYS
        ? { date: finish, value: 0 }
        : { date: addDays(anchor, MAX_PROJECTION_DAYS), value: remaining - (rate * MAX_PROJECTION_DAYS) / 7 };
    return { finish, end };
  };

  const trend = projectAt(avgRate);
  const projFinish: Date | null = trend.finish; // predicted date remaining hits 0
  const trendEnd = trend.end; // where the drawn line stops

  // Scenario lines around the trend: best = 1.5× the current rate, worst = ½×.
  const bestRate = avgRate && avgRate > 0 ? avgRate * 1.5 : null;
  const worstRate = avgRate && avgRate > 0 ? avgRate / 2 : null;
  const best = projectAt(bestRate);
  const worst = projectAt(worstRate);
  const vsPlanWeeks = projFinish && plannedEnd ? Math.round(diffDays(projFinish, plannedEnd) / 7) : null;

  const t0 = start.getTime();
  const t1 = Math.max(
    end.getTime(),
    today.getTime(),
    plannedEnd ? plannedEnd.getTime() : 0,
    trendEnd ? trendEnd.date.getTime() : 0,
    best.end ? best.end.date.getTime() : 0,
    worst.end ? worst.end.date.getTime() : 0,
  );
  const span = Math.max(1, t1 - t0);

  const maxVal = Math.max(
    data.initialRemaining,
    ...points.map((p) => p.remaining),
    ...(showScope ? points.map((p) => p.scope) : [0]),
  );
  const yMax = Math.max(1, maxVal) * 1.1;

  const xOf = (ms: number) => ML + ((ms - t0) / span) * PLOT_W;
  const yOf = (v: number) => Y_BASE - (v / yMax) * PLOT_H;
  const xDate = (iso: string) => xOf(parseISO(iso).getTime());

  const actualPts = points.map((p) => `${xOf(parseISO(p.date).getTime())},${yOf(p.remaining)}`).join(' ');
  const scopePts = points.map((p) => `${xOf(parseISO(p.date).getTime())},${yOf(p.scope)}`).join(' ');

  // Y ticks (0 .. yMax in 4 steps)
  const yTicks = [0, 1, 2, 3, 4].map((i) => (yMax * i) / 4);
  // Month ticks across the range
  const monthTicks: { ms: number; label: string }[] = [];
  let m = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  if (m.getTime() < t0) m = new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth() + 1, 1));
  while (m.getTime() <= t1 && monthTicks.length < 24) {
    const label =
      m.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' }) +
      (m.getUTCMonth() === 0 ? ` '${String(m.getUTCFullYear()).slice(2)}` : '');
    monthTicks.push({ ms: m.getTime(), label });
    m = new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth() + 1, 1));
  }

  const todayMs = today.getTime();
  const todayInRange = todayMs >= t0 && todayMs <= t1;

  return (
    <div className="risk-page">
      {head}

      <div className="burndown-stats">
        <div className="risk-card">
          <span className="risk-card-label">Remaining + blocked</span>
          <strong>{Math.round(remaining)} hrs</strong>
        </div>
        <div className="risk-card">
          <span className="risk-card-label">Completed to date</span>
          <strong>{Math.round(completed)} hrs</strong>
        </div>
        <div className="risk-card">
          <span className="risk-card-label">% complete</span>
          <strong style={{ color: COL.actual }}>{pct}%</strong>
        </div>
        <div className="risk-card">
          <span className="risk-card-label">Projected finish</span>
          <strong>{projFinish ? formatDisplay(projFinish) : '—'}</strong>
          <span className="risk-card-sub">
            {remaining <= 0
              ? 'No remaining work'
              : avgRate && avgRate > 0
                ? `at ${Math.round(avgRate)} hrs/wk ${rateBasis}` +
                  (vsPlanWeeks == null
                    ? ''
                    : vsPlanWeeks === 0
                      ? ' · on the final sprint'
                      : ` · ${Math.abs(vsPlanWeeks)} wk${Math.abs(vsPlanWeeks) === 1 ? '' : 's'} ${vsPlanWeeks > 0 ? 'after' : 'before'} final sprint`)
                : 'Not enough weekly history yet'}
          </span>
        </div>
      </div>

      <div className="chart-card">
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Project burndown" style={{ maxWidth: '100%', height: 'auto', display: 'block', fontFamily: 'inherit' }}>
          <rect x={0} y={0} width={W} height={H} fill="#ffffff" />

          {/* Y gridlines + labels */}
          {yTicks.map((v, i) => (
            <g key={`y${i}`}>
              <line x1={ML} y1={yOf(v)} x2={ML + PLOT_W} y2={yOf(v)} stroke={COL.grid} strokeWidth={1} />
              <text x={ML - 8} y={yOf(v)} textAnchor="end" dominantBaseline="middle" fontSize={11} fill={COL.axis}>
                {Math.round(v)}
              </text>
            </g>
          ))}

          {/* Month ticks + labels */}
          {monthTicks.map((t, i) => (
            <g key={`m${i}`}>
              <line x1={xOf(t.ms)} y1={MT} x2={xOf(t.ms)} y2={Y_BASE} stroke={COL.grid} strokeWidth={1} />
              <text x={xOf(t.ms)} y={Y_BASE + 16} textAnchor="middle" fontSize={11} fill={COL.axis}>
                {t.label}
              </text>
            </g>
          ))}

          {/* Scenario lines: worst (½× current rate) and best (1.5×) */}
          {[
            { key: 'worst', end: worst.end, color: COL.worst },
            { key: 'best', end: best.end, color: COL.best },
          ].map(
            (l) =>
              l.end && (
                <g key={l.key}>
                  <line
                    x1={xDate(last.date)}
                    y1={yOf(remaining)}
                    x2={xOf(l.end.date.getTime())}
                    y2={yOf(l.end.value)}
                    stroke={l.color}
                    strokeWidth={1.5}
                    strokeDasharray="6 5"
                  />
                  {l.end.value <= 0 && <circle cx={xOf(l.end.date.getTime())} cy={yOf(0)} r={3} fill={l.color} />}
                </g>
              ),
          )}

          {/* Trend: average burn rate projected forward from the latest snapshot */}
          {trendEnd && (
            <g>
              <line
                x1={xDate(last.date)}
                y1={yOf(remaining)}
                x2={xOf(trendEnd.date.getTime())}
                y2={yOf(trendEnd.value)}
                stroke={COL.trend}
                strokeWidth={1.5}
                strokeDasharray="6 5"
              />
              {trendEnd.value <= 0 && (
                <circle cx={xOf(trendEnd.date.getTime())} cy={yOf(0)} r={3.5} fill={COL.axis} />
              )}
              {projFinish && (
                <text
                  x={xOf(trendEnd.date.getTime()) - 6}
                  y={Y_BASE - 10}
                  textAnchor="end"
                  fontSize={11}
                  fontWeight={600}
                  fill={COL.axis}
                  stroke="#ffffff"
                  strokeWidth={4}
                  strokeLinejoin="round"
                  paintOrder="stroke"
                >
                  {trendEnd.value > 0 ? `Finish ${formatShort(projFinish)} '${String(projFinish.getUTCFullYear()).slice(2)} →` : `Finish · ${formatShort(projFinish)}`}
                </text>
              )}
            </g>
          )}

          {/* Optional total-scope line */}
          {showScope && <polyline points={scopePts} fill="none" stroke={COL.scope} strokeWidth={1.5} />}

          {/* Actual remaining (Remaining Work + Blocked Time) line */}
          <polyline points={actualPts} fill="none" stroke={COL.actual} strokeWidth={2} strokeLinejoin="round" />

          {/* Today marker */}
          {todayInRange && (
            <g>
              <line x1={xOf(todayMs)} y1={MT} x2={xOf(todayMs)} y2={Y_BASE} stroke={COL.today} strokeWidth={1.5} strokeDasharray="5 4" />
              <text x={xOf(todayMs)} y={MT - 4} textAnchor="middle" fontSize={11} fontWeight={600} fill={COL.today}>
                {`Today · ${formatShort(today)}`}
              </text>
            </g>
          )}

          {/* Axes */}
          <line x1={ML} y1={Y_BASE} x2={ML + PLOT_W} y2={Y_BASE} stroke={COL.axis} strokeWidth={1} />
        </svg>
      </div>

      <div className="burndown-legend">
        <span><i className="swatch" style={{ background: COL.actual }} /> Actual remaining + blocked</span>
        <span><i className="swatch dashed" style={{ borderColor: COL.trend }} /> {observed ? 'Trend (observed rate)' : 'Trend (avg burn / wk)'}</span>
        {best.end && bestRate && (
          <span>
            <i className="swatch dashed" style={{ borderColor: COL.best }} /> 1.5× current rate ({Math.round(bestRate)} hrs/wk) ·{' '}
            {best.finish ? formatDisplay(best.finish) : '—'}
          </span>
        )}
        {worst.end && worstRate && (
          <span>
            <i className="swatch dashed" style={{ borderColor: COL.worst }} /> ½ current rate ({Math.round(worstRate)} hrs/wk) ·{' '}
            {worst.finish ? formatDisplay(worst.finish) : '—'}
          </span>
        )}
        <label className="burndown-toggle">
          <input type="checkbox" checked={showScope} onChange={(e) => setShowScope(e.target.checked)} />
          Show total scope
        </label>
      </div>
    </div>
  );
}
