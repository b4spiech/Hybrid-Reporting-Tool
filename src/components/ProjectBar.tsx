import { useState } from 'react';
import type { Project } from '../types';

type Props = {
  projects: Project[];
  activeId: string | null;
  present: boolean;
  onSwitch: (id: string) => void;
  onNew: () => void;
  onDuplicate: () => void;
  onRename: () => void;
  onDelete: () => void;
};

export function ProjectBar({
  projects,
  activeId,
  present,
  onSwitch,
  onNew,
  onDuplicate,
  onRename,
  onDelete,
}: Props) {
  const [confirming, setConfirming] = useState(false);
  const active = projects.find((p) => p.id === activeId);

  return (
    <div className="project-bar">
      <label className="project-select">
        <span>Project</span>
        <select value={activeId ?? ''} onChange={(e) => onSwitch(e.target.value)}>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>

      {!present && (
        <div className="project-actions">
          <button onClick={onNew}>New</button>
          <button onClick={onDuplicate}>Duplicate</button>
          <button onClick={onRename}>Rename</button>
          {confirming ? (
            <span className="confirm">
              <span className="confirm-text">Delete “{active?.name}”?</span>
              <button
                className="danger-solid"
                onClick={() => {
                  onDelete();
                  setConfirming(false);
                }}
              >
                Delete
              </button>
              <button onClick={() => setConfirming(false)}>Cancel</button>
            </span>
          ) : (
            <button className="link danger" onClick={() => setConfirming(true)}>
              Delete
            </button>
          )}
        </div>
      )}
    </div>
  );
}
