import type { GanttRow } from '../types';

type Props = {
  rows: GanttRow[];
  sprintCount: number;
  onChange: (rows: GanttRow[]) => void;
  onAdd: () => void;
};

export function RowsTable({ rows, sprintCount, onChange, onAdd }: Props) {
  const update = (id: string, patch: Partial<GanttRow>) => {
    onChange(rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  };
  const remove = (id: string) => onChange(rows.filter((r) => r.id !== id));

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Workstreams</h2>
        <button className="primary" onClick={onAdd}>
          + Add line
        </button>
      </div>
      <div className="table-wrap">
        <table className="rows-table">
          <thead>
            <tr>
              <th className="col-name">Name</th>
              <th className="col-num">Start sprint</th>
              <th className="col-num">Completion sprint</th>
              <th className="col-pct">% complete</th>
              <th className="col-notes">Notes</th>
              <th className="col-actions" aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>
                  <input
                    type="text"
                    value={row.name}
                    onChange={(e) => update(row.id, { name: e.target.value })}
                    placeholder="Workstream name"
                  />
                </td>
                <td>
                  <input
                    type="number"
                    min={1}
                    max={sprintCount}
                    value={row.startSprint}
                    onChange={(e) =>
                      update(row.id, { startSprint: clampInt(e.target.value, 1, sprintCount, 1) })
                    }
                  />
                </td>
                <td>
                  <input
                    type="number"
                    min={1}
                    max={sprintCount}
                    value={row.endSprint}
                    onChange={(e) =>
                      update(row.id, { endSprint: clampInt(e.target.value, 1, sprintCount, 1) })
                    }
                  />
                </td>
                <td>
                  <div className="pct-cell">
                    <input
                      type="range"
                      min={0}
                      max={100}
                      value={row.percentComplete}
                      onChange={(e) => update(row.id, { percentComplete: Number(e.target.value) })}
                    />
                    <input
                      type="number"
                      min={0}
                      max={100}
                      value={row.percentComplete}
                      onChange={(e) =>
                        update(row.id, { percentComplete: clampInt(e.target.value, 0, 100, 0) })
                      }
                    />
                  </div>
                </td>
                <td>
                  <input
                    type="text"
                    value={row.notes ?? ''}
                    onChange={(e) => update(row.id, { notes: e.target.value || undefined })}
                    placeholder="—"
                  />
                </td>
                <td>
                  <button
                    className="link danger"
                    onClick={() => remove(row.id)}
                    aria-label={`Delete ${row.name}`}
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="empty-row">
                  No workstreams yet. Click “Add line” to create one.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function clampInt(value: string, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}
