import type { SprintConfig } from '../types';
import { computeSprints, sprintDuration } from '../sprints';
import { formatDisplay } from '../dates';

type Props = {
  config: SprintConfig;
  onChange: (next: SprintConfig) => void;
  todayOverride?: string;
  onTodayOverrideChange: (value: string | undefined) => void;
};

export function ConfigPanel({ config, onChange, todayOverride, onTodayOverrideChange }: Props) {
  const sprints = computeSprints(config);

  const setOverride = (index: number, value: string) => {
    const overrides = { ...(config.durationOverrides ?? {}) };
    if (value === '') {
      delete overrides[index];
    } else {
      const n = Math.max(1, Math.round(Number(value)));
      if (Number.isFinite(n)) overrides[index] = n;
    }
    onChange({ ...config, durationOverrides: overrides });
  };

  return (
    <section className="panel">
      <h2>Sprint configuration</h2>
      <div className="field-grid">
        <label>
          <span>Start date (Sprint 1, day 1)</span>
          <input
            type="date"
            value={config.startDate.slice(0, 10)}
            onChange={(e) => onChange({ ...config, startDate: e.target.value })}
          />
        </label>
        <label>
          <span>Number of sprints</span>
          <input
            type="number"
            min={1}
            max={60}
            value={config.sprintCount}
            onChange={(e) => onChange({ ...config, sprintCount: clamp(e.target.value, 1, 60, 10) })}
          />
        </label>
        <label>
          <span>Default duration (days)</span>
          <input
            type="number"
            min={1}
            max={365}
            value={config.defaultDurationDays}
            onChange={(e) => onChange({ ...config, defaultDurationDays: clamp(e.target.value, 1, 365, 7) })}
          />
        </label>
        <label>
          <span>Milestone finish date</span>
          <select
            value={config.endConvention}
            onChange={(e) =>
              onChange({ ...config, endConvention: e.target.value as SprintConfig['endConvention'] })
            }
          >
            <option value="lastWorkingDay">Last working day (Fri)</option>
            <option value="calendarEnd">Last calendar day</option>
          </select>
        </label>
        <label>
          <span>Today override (what-if)</span>
          <div className="inline">
            <input
              type="date"
              value={todayOverride?.slice(0, 10) ?? ''}
              onChange={(e) => onTodayOverrideChange(e.target.value || undefined)}
            />
            {todayOverride && (
              <button className="link" onClick={() => onTodayOverrideChange(undefined)}>
                reset
              </button>
            )}
          </div>
        </label>
      </div>

      <h3>Per-sprint duration overrides</h3>
      <p className="hint">Leave blank to use the default. Dates recompute as you type.</p>
      <div className="sprint-overrides">
        {sprints.map((s) => {
          const overridden = config.durationOverrides?.[s.index] !== undefined;
          return (
            <div key={s.index} className={`sprint-chip${overridden ? ' overridden' : ''}`}>
              <div className="sprint-chip-head">
                <strong>S{s.index}</strong>
                <span>{formatDisplay(s.finish)}</span>
              </div>
              <input
                type="number"
                min={1}
                placeholder={String(config.defaultDurationDays)}
                value={overridden ? sprintDuration(config, s.index) : ''}
                onChange={(e) => setOverride(s.index, e.target.value)}
                aria-label={`Sprint ${s.index} duration in days`}
              />
            </div>
          );
        })}
      </div>
    </section>
  );
}

function clamp(value: string, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}
