// Everything personal lives here, in this browser only: the server never stores it.
import { useSyncExternalStore } from "react";
import { upsertRun } from "../../shared/history.ts";
import type { Profile, Run } from "../../shared/types.ts";

const PROFILE_KEY = "auto-park:profile";
const HISTORY_KEY = "auto-park:history";

export const EMPTY_PROFILE: Profile = { vehicles: [], defaultVehicleId: null, phone: "", promoCode: "", preferredRate: "", engine: "auto" };

/** False in private browsing or when storage is blocked: details then last only until the tab closes. */
export let storageWorks = true;

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    storageWorks = false;
    return fallback;
  }
}

function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    storageWorks = false;
  }
}

let profile: Profile = { ...EMPTY_PROFILE, ...read<Partial<Profile>>(PROFILE_KEY, {}) };
let history: Run[] = read<Run[]>(HISTORY_KEY, []);
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

// Keep other tabs in sync.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key === PROFILE_KEY) profile = { ...EMPTY_PROFILE, ...read<Partial<Profile>>(PROFILE_KEY, {}) };
    else if (e.key === HISTORY_KEY) history = read<Run[]>(HISTORY_KEY, []);
    else return;
    notify();
  });
}

export function useProfile(): Profile {
  return useSyncExternalStore(subscribe, () => profile);
}

export function useHistory(): Run[] {
  return useSyncExternalStore(subscribe, () => history);
}

export function getProfile() {
  return profile;
}

export function getHistory() {
  return history;
}

export function saveProfile(next: Profile) {
  profile = next;
  write(PROFILE_KEY, next);
  notify();
}

export function recordRun(run: Run) {
  history = upsertRun(history, run);
  write(HISTORY_KEY, history);
  notify();
}

/** Clear everything this device knows about you. */
export function forgetEverything() {
  profile = { ...EMPTY_PROFILE };
  history = [];
  try {
    localStorage.removeItem(PROFILE_KEY);
    localStorage.removeItem(HISTORY_KEY);
  } catch {
    // nothing stored anyway
  }
  notify();
}
