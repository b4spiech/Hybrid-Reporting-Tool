import type { ProjectState } from './types';
import { normalize } from './storage';

/**
 * Persistence backend for the project state. Kept as an interface so a remote
 * backend (API / cloud) can be dropped in later without touching the app.
 * For now the only implementation is LocalStorageStore.
 */
export interface ProjectStore {
  /** The persisted project, or null if nothing has been stored yet. */
  load(): ProjectState | null;
  save(state: ProjectState): void;
  clear(): void;
}

export class LocalStorageStore implements ProjectStore {
  constructor(private readonly key = 'tracking-gantt.project.v2') {}

  load(): ProjectState | null {
    try {
      const raw = localStorage.getItem(this.key);
      if (!raw) return null;
      return normalize(JSON.parse(raw));
    } catch {
      return null;
    }
  }

  save(state: ProjectState): void {
    try {
      localStorage.setItem(this.key, JSON.stringify(state));
    } catch {
      // Quota or disabled storage — non-fatal; in-memory state still works.
    }
  }

  clear(): void {
    try {
      localStorage.removeItem(this.key);
    } catch {
      // ignore
    }
  }
}
