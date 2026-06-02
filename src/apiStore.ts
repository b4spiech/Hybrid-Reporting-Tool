import type { AppState } from './types';
import { normalizeAppState } from './storage';
import { LocalStorageStore, type ProjectStore } from './store';

const ENDPOINT = '/api/state';
const DEBOUNCE_MS = 500;

/**
 * The backend (SQLite on disk) is the source of truth. ApiStore reads/writes
 * the whole AppState over REST, debouncing saves so rapid edits don't spam the
 * server. LocalStorageStore is kept only as:
 *  - a write-through cache + offline fallback when the backend is unreachable,
 *  - the source for the one-time migration into an empty database.
 */
export class ApiStore implements ProjectStore {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending: AppState | null = null;

  constructor(private readonly fallback = new LocalStorageStore()) {}

  async load(): Promise<AppState | null> {
    try {
      const res = await fetch(ENDPOINT, { headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(`GET ${ENDPOINT} -> ${res.status}`);
      const raw = await res.json();
      const dbEmpty = !raw || !Array.isArray(raw.projects) || raw.projects.length === 0;

      if (dbEmpty) {
        // One-time migration: push any existing local data into the empty DB.
        const local = this.fallback.loadSync();
        if (local && local.projects.length > 0) {
          await this.put(local);
          return local;
        }
        return null; // brand new — let the app seed a default and save it back.
      }

      const state = normalizeAppState(raw);
      this.fallback.save(state); // refresh the offline cache
      return state;
    } catch {
      // Backend unreachable — fall back to the last known local copy.
      return this.fallback.loadSync();
    }
  }

  save(state: AppState): void {
    this.fallback.save(state); // write-through cache (immediate, synchronous)
    this.pending = state;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      const toSend = this.pending;
      this.pending = null;
      if (toSend) this.put(toSend).catch(() => {});
    }, DEBOUNCE_MS);
  }

  clear(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending = null;
    this.fallback.clear();
  }

  /** Send the full AppState to the backend (used by save + migration). */
  private async put(state: AppState): Promise<void> {
    const res = await fetch(ENDPOINT, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(state),
    });
    if (!res.ok) throw new Error(`PUT ${ENDPOINT} -> ${res.status}`);
  }
}
