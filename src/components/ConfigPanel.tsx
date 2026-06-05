import type { SprintConfig } from '../types';

type Props = {
  config: SprintConfig;
  onChange: (next: SprintConfig) => void;
  todayOverride?: string;
  onTodayOverrideChange: (value: string | undefined) => void;
  description?: string;
  aliases?: string[];
  onDescriptionChange: (value: string | undefined) => void;
  onAliasesChange: (value: string[]) => void;
};

export function ConfigPanel({
  config,
  onChange,
  todayOverride,
  onTodayOverrideChange,
  description,
  aliases,
  onDescriptionChange,
  onAliasesChange,
}: Props) {
  const adoDriven = Array.isArray(config.sprintDates) && config.sprintDates.length > 0;
  return (
    <section className="panel">
      <h2>Project details</h2>
      <div className="field-grid">
        <label className="span-2">
          <span>Description</span>
          <textarea
            rows={2}
            value={description ?? ''}
            onChange={(e) => onDescriptionChange(e.target.value || undefined)}
            placeholder="What this project covers"
          />
        </label>
        <label className="span-2">
          <span>Aliases (comma-separated)</span>
          <input
            type="text"
            value={(aliases ?? []).join(', ')}
            onChange={(e) =>
              onAliasesChange(
                e.target.value
                  .split(',')
                  .map((s) => s.trim())
                  .filter(Boolean),
              )
            }
            placeholder="e.g. ERP, S/4HANA, finance migration"
          />
        </label>
      </div>
      <p className="hint">Aliases (and the project name) are used to auto-tag transcripts to this project.</p>

      <h2 style={{ marginTop: 18 }}>Sprint configuration</h2>
      {adoDriven && (
        <p className="hint">
          Sprint dates come from Azure DevOps ({config.sprintDates!.length} sprints). The start date
          and default duration below are a fallback, used only if ADO has no sprint dates.
        </p>
      )}
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
          <span>Default duration (weeks)</span>
          <input
            type="number"
            min={1}
            max={52}
            value={config.defaultDurationWeeks}
            onChange={(e) => onChange({ ...config, defaultDurationWeeks: clamp(e.target.value, 1, 52, 1) })}
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
    </section>
  );
}

function clamp(value: string, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}
