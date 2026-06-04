import type { Project, ProjectRisk } from '../types';
import { computeSprints } from '../sprints';
import { formatDisplay, parseISO } from '../dates';
import { observedRate as computeObservedRate, sliderDefault, projectMilestones, impliedRate } from '../risk';

type Props = {
  project: Project;
  today: Date;
  onRiskChange: (patch: Partial<ProjectRisk>) => void;
  onBack: () => void;
};

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
const clamp01 = (v: number) => clamp(v, 0, 1);

// Schematic colors (fixed; the chart renders on white paper like the Gantt).
const COL = {
  best: '#3B6D11',
  worst: '#A32D2D',
  actual: '#185FA5',
  post: '#85B7EB',
  preFill: '#D3D1C7',
  preStroke: '#5F5E5A',
  secondary: '#5a6b80',
};

export function RiskPage({ project, today, onRiskChange, onBack }: Props) {
  const risk = project.risk ?? {};
  const milestoneName = (risk.milestoneName ?? '').trim() || 'Go-live';

  // --- Inputs / derived values -------------------------------------------
  const totalCompletedHrs = project.totalCompletedHrs ?? 0;
  const totalRemainingDefault = project.totalRemainingHrs ?? 0;
  const remainingOverridden = risk.remainingOverride != null;
  const remainingHrs = risk.remainingOverride ?? totalRemainingDefault;

  const sprints = computeSprints(project.sprints);
  const historicalStart = risk.historicalStart ? parseISO(risk.historicalStart) : sprints[0].start;
  const projectFrom = risk.projectFrom ? parseISO(risk.projectFrom) : today;

  const observedRate = computeObservedRate(totalCompletedHrs, historicalStart, today);

  const bestRate = risk.bestRate ?? (observedRate && observedRate > 0 ? Math.round(observedRate) : 40);
  const worstRate = risk.worstRate ?? Math.max(1, Math.round(bestRate / 2));
  const postWeeks = risk.postWeeks ?? 2;

  const s =
    risk.sliderOverride != null ? clamp01(risk.sliderOverride) : sliderDefault(observedRate, bestRate, worstRate);

  // --- Geometry (fixed schematic scale; NOT real dates) ------------------
  const yTop = 62;
  const yBase = 170;
  const sprintX = 95;
  const cbX = 140;
  const cwX = 250;
  const attX = cbX + s * (cwX - cbX);
  const boxLen = clamp(postWeeks * 3, 20, 300);
  const milestoneX = attX + boxLen;

  // --- Dates (projected forward from today; labels only) -----------------
  const { bestMs, worstMs, selCompDate, selMs, windowWeeks } = projectMilestones({
    remainingHrs,
    bestRate,
    worstRate,
    postWeeks,
    projectFrom,
    s,
  });

  // Burndown rate the blue line is currently using (from the selected completion).
  const rate = impliedRate({ remainingHrs, projectFrom, selCompDate, s, bestRate, worstRate });
  const rateLabel = rate != null ? `${Math.round(rate)} hrs/wk` : '—';

  const fmt = (d: Date | null) => (d ? formatDisplay(d) : '—');

  // --- Persisted-field editors -------------------------------------------
  const num = (v: string): number | undefined => (v === '' ? undefined : Number(v));

  return (
    <div className="risk-page">
      <div className="risk-head">
        <button className="link" onClick={onBack}>
          ← Back to chart
        </button>
        <h2>Schedule risk — {project.name}</h2>
      </div>

      <div className="chart-card">
        <svg viewBox="0 0 680 225" role="img" aria-label="Schedule risk burndown schematic" style={{ maxWidth: '100%', height: 'auto', display: 'block', fontFamily: 'inherit' }}>
          <rect x={0} y={0} width={680} height={225} fill="#ffffff" />

          {/* baseline */}
          <line x1={60} y1={yBase} x2={600} y2={yBase} stroke="var(--color-border-secondary)" strokeWidth={0.5} />

          {/* legend (top-right) */}
          <line x1={372} y1={50} x2={392} y2={50} stroke={COL.best} strokeWidth={1.5} strokeDasharray="6 5" />
          <text x={398} y={50} dominantBaseline="middle" fontSize={11} fontWeight={500} fill={COL.best}>
            Best historical rate
          </text>
          <line x1={372} y1={70} x2={392} y2={70} stroke={COL.worst} strokeWidth={1.5} strokeDasharray="6 5" />
          <text x={398} y={70} dominantBaseline="middle" fontSize={11} fontWeight={500} fill={COL.worst}>
            Worst historical rate
          </text>

          {/* pre-sprint stub (work to date, left of today) */}
          <text x={60} y={46} fontSize={12} fill={COL.secondary}>
            Pre-sprint
          </text>
          <rect x={60} y={57.5} width={sprintX - 60} height={9} rx={3} fill={COL.preFill} stroke={COL.preStroke} strokeWidth={0.75} />

          {/* corridor + actual */}
          <line x1={sprintX} y1={yTop} x2={cbX} y2={yBase} stroke={COL.best} strokeWidth={1.5} strokeDasharray="6 5" strokeLinecap="round" />
          <line x1={sprintX} y1={yTop} x2={cwX} y2={yBase} stroke={COL.worst} strokeWidth={1.5} strokeDasharray="6 5" strokeLinecap="round" />
          <line x1={sprintX} y1={yTop} x2={attX} y2={yBase} stroke={COL.actual} strokeWidth={1.25} strokeLinecap="round" />

          {/* post-sprint tasks bar */}
          <text x={attX + boxLen / 2} y={yBase - 10} textAnchor="middle" fontSize={12} fill={COL.secondary}>
            Post-sprint tasks
          </text>
          <rect x={attX} y={yBase - 4.5} width={boxLen} height={9} rx={3} fill={COL.post} stroke={COL.actual} strokeWidth={1} />

          {/* attachment + milestone */}
          <circle cx={attX} cy={yBase} r={5} fill="var(--color-background-primary)" stroke={COL.actual} strokeWidth={1.5} />
          <path
            d={`M ${milestoneX} ${yBase - 10} L ${milestoneX + 10} ${yBase} L ${milestoneX} ${yBase + 10} L ${milestoneX - 10} ${yBase} Z`}
            fill="var(--color-text-primary)"
          />
          <text x={milestoneX} y={yBase + 28} textAnchor="middle" fontSize={12} fontWeight={500} fill="var(--color-text-primary)">
            {milestoneName}
          </text>
          <text x={milestoneX} y={yBase + 43} textAnchor="middle" fontSize={11} fill={COL.secondary}>
            {fmt(selMs)}
          </text>
        </svg>
      </div>

      {/* slider */}
      <div className="risk-slider">
        <span>Best rate</span>
        <div className="risk-slider-track">
          <div className="risk-rate-flag" style={{ left: `${Math.round(s * 100)}%` }}>
            {rateLabel}
          </div>
          <input
            type="range"
            min={0}
            max={100}
            value={Math.round(s * 100)}
            onChange={(e) => onRiskChange({ sliderOverride: Number(e.target.value) / 100 })}
            aria-label="Schedule position between best and worst rate"
          />
        </div>
        <span>Worst rate</span>
        {risk.sliderOverride != null && (
          <button className="link" onClick={() => onRiskChange({ sliderOverride: undefined })}>
            reset to observed
          </button>
        )}
      </div>

      {/* cards */}
      <div className="risk-cards">
        <div className="risk-card" style={{ borderTopColor: COL.best }}>
          <span className="risk-card-label">Best rate (earliest)</span>
          <strong style={{ color: COL.best }}>{fmt(bestMs)}</strong>
        </div>
        <div className="risk-card" style={{ borderTopColor: COL.actual }}>
          <span className="risk-card-label">Actual (selected)</span>
          <strong style={{ color: COL.actual }}>
            {fmt(selMs)}
            {rate != null ? ` · ${Math.round(rate)} hrs/wk` : ''}
          </strong>
        </div>
        <div className="risk-card" style={{ borderTopColor: COL.worst }}>
          <span className="risk-card-label">Worst rate (latest)</span>
          <strong style={{ color: COL.worst }}>{fmt(worstMs)}</strong>
        </div>
      </div>

      {/* risk sentence */}
      <p className="risk-sentence">
        {bestMs && worstMs ? (
          <>
            “{milestoneName}” lands between <strong>{fmt(bestMs)}</strong> and <strong>{fmt(worstMs)}</strong>
            {windowWeeks != null ? ` (a ${windowWeeks}-week window)` : ''}; at the selected rate it is currently
            tracking to <strong>{fmt(selMs)}</strong>.
          </>
        ) : (
          'Enter best and worst rates (and remaining work) to project the milestone corridor.'
        )}
      </p>

      {/* persisted inputs */}
      <section className="panel">
        <h2>Inputs</h2>
        <div className="field-grid">
          <label>
            <span>Milestone name</span>
            <input
              type="text"
              value={risk.milestoneName ?? ''}
              placeholder="Go-live"
              onChange={(e) => onRiskChange({ milestoneName: e.target.value || undefined })}
            />
          </label>
          <label>
            <span>Best rate (hrs/wk)</span>
            <input type="number" min={0} value={bestRate} onChange={(e) => onRiskChange({ bestRate: num(e.target.value) })} />
          </label>
          <label>
            <span>Worst rate (hrs/wk)</span>
            <input type="number" min={0} value={worstRate} onChange={(e) => onRiskChange({ worstRate: num(e.target.value) })} />
          </label>
          <label>
            <span>Post-sprint duration (weeks)</span>
            <input type="number" min={0} value={postWeeks} onChange={(e) => onRiskChange({ postWeeks: num(e.target.value) })} />
          </label>
          <label>
            <span>
              Remaining work (hrs)
              {remainingOverridden ? (
                <em className="edited-tag">edited</em>
              ) : (
                <em className="ado-tag">from ADO</em>
              )}
            </span>
            <div className="inline">
              <input
                type="number"
                min={0}
                value={remainingOverridden ? risk.remainingOverride : totalRemainingDefault}
                onChange={(e) => onRiskChange({ remainingOverride: num(e.target.value) })}
              />
              <button
                type="button"
                className={`reset-btn${remainingOverridden ? ' active' : ''}`}
                disabled={!remainingOverridden}
                title={`Reset to ADO total (${Math.round(totalRemainingDefault)} hrs)`}
                aria-label={`Reset to ADO total (${Math.round(totalRemainingDefault)} hrs)`}
                onClick={() => onRiskChange({ remainingOverride: undefined })}
              >
                ↺
              </button>
            </div>
          </label>
          <label>
            <span>Project from (override)</span>
            <input
              type="date"
              value={risk.projectFrom?.slice(0, 10) ?? ''}
              onChange={(e) => onRiskChange({ projectFrom: e.target.value || undefined })}
            />
          </label>
          <label>
            <span>Historical start (override)</span>
            <input
              type="date"
              value={risk.historicalStart?.slice(0, 10) ?? ''}
              onChange={(e) => onRiskChange({ historicalStart: e.target.value || undefined })}
            />
          </label>
        </div>
        <p className="hint">
          Observed rate: {observedRate != null ? `${Math.round(observedRate)} hrs/wk` : '— (not enough history)'} ·
          Completed to date: {Math.round(totalCompletedHrs)} hrs · Remaining: {Math.round(totalRemainingDefault)} hrs ·
          Projecting from {formatDisplay(projectFrom)}.
        </p>
      </section>
    </div>
  );
}
