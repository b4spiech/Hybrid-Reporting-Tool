import { useEffect, useState } from 'react';
import type { Project } from '../types';
import { parseISO, formatShort } from '../dates';

type Point = { date: string; remaining: number; completed: number; scope: number };
type BurndownData = {
  start: string | null;
  end: string;
  plannedEnd: string | null;
  initialRemaining: number;
  points: Point[];
};

type Props = {
  project: Project;
  today: Date;
  onBack: () => void;
};

const COL = {
  actual: '#185FA5',
  ideal: '#9aa7b5',
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
  const t0 = start.getTime();
  const t1 = Math.max(end.getTime(), today.getTime(), plannedEnd ? plannedEnd.getTime() : 0);
  const span = Math.max(1, t1 - t0);

  const last = points[points.length - 1];
  const remaining = last.remaining;
  const completed = last.completed;
  const pct = completed + remaining > 0 ? Math.round((completed / (completed + remaining)) * 100) : 0;

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
  const idealEnd = plannedEnd ?? end;

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
          <span className="risk-card-label">Remaining</span>
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

          {/* Ideal guideline */}
          <line
            x1={xDate(data.start ?? points[0].date)}
            y1={yOf(data.initialRemaining)}
            x2={xOf(idealEnd.getTime())}
            y2={yOf(0)}
            stroke={COL.ideal}
            strokeWidth={1.5}
            strokeDasharray="6 5"
          />

          {/* Optional total-scope line */}
          {showScope && <polyline points={scopePts} fill="none" stroke={COL.scope} strokeWidth={1.5} />}

          {/* Actual remaining line */}
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
        <span><i className="swatch" style={{ background: COL.actual }} /> Actual remaining</span>
        <span><i className="swatch dashed" style={{ borderColor: COL.ideal }} /> Ideal</span>
        <label className="burndown-toggle">
          <input type="checkbox" checked={showScope} onChange={(e) => setShowScope(e.target.checked)} />
          Show total scope
        </label>
      </div>
    </div>
  );
}
