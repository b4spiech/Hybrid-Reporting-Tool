import type { AppState } from './types';
import { normalizeAppState } from './storage';

/**
 * Persistence backend for the whole app state (all projects). Async so an HTTP
 * backend can implement it; the local-storage implementation just resolves
 * immediately. The app talks only to this interface.
 */
export interface ProjectStore {
  /** The persisted app state, or null if nothing has been stored yet. */
  load(): Promise<AppState | null>;
  save(state: AppState): void;
  clear(): void;
}

const KEY = 'tracking-gantt.app.v3'; // multi-project AppState
const LEGACY_KEY = 'tracking-gantt.project.v2'; // single-project ProjectState

export class LocalStorageStore implements ProjectStore {
  constructor(
    private readonly key = KEY,
    private readonly legacyKey = LEGACY_KEY,
  ) {}

  async load(): Promise<AppState | null> {
    return this.loadSync();
  }

  /** Synchronous read — used directly by ApiStore for the offline fallback. */
  loadSync(): AppState | null {
    try {
      const raw = localStorage.getItem(this.key);
      if (raw) return normalizeAppState(JSON.parse(raw));

      // Migrate a pre-multi-project record: wrap it as the first project and
      // re-save under the new key, then retire the old record.
      const legacy = localStorage.getItem(this.legacyKey);
      if (legacy) {
        const migrated = normalizeAppState(JSON.parse(legacy));
        this.save(migrated);
        try {
          localStorage.removeItem(this.legacyKey);
        } catch {
          // ignore
        }
        return migrated;
      }
      return null;
    } catch {
      return null;
    }
  }

  save(state: AppState): void {
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
