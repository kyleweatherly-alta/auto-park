import type { ApiError, Profile, Rate, Run, StartRunRequest, Status } from "../../shared/types.ts";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: Partial<ApiError> & { fields?: Record<string, string> },
  ) {
    super(body.message || `Request failed (${status})`);
  }
}

/** Fired when the server says we're logged out, so the app can show the passcode screen. */
export const onUnauthorized = new EventTarget();

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      credentials: "same-origin",
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new HttpError(0, { error: "offline", message: "Can't reach Auto-Park. Check your connection and try again." });
  }
  if (res.status === 204) return undefined as T;
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    if (res.status === 401 && url !== "/api/login") onUnauthorized.dispatchEvent(new Event("unauthorized"));
    const fallback = { error: "http_error", message: res.status >= 500 ? "The server had a problem. Try again in a moment." : `Request failed (${res.status}).` };
    throw new HttpError(res.status, (data && typeof data === "object" ? data : fallback) as ApiError);
  }
  return data as T;
}

export const api = {
  session: () => request<{ authenticated: boolean }>("GET", "/api/session"),
  login: (passcode: string) => request<void>("POST", "/api/login", { passcode }),
  logout: () => request<void>("POST", "/api/logout"),
  status: () => request<Status>("GET", "/api/status"),
  profile: () => request<Profile>("GET", "/api/profile"),
  saveProfile: (p: Profile) => request<Profile>("PUT", "/api/profile", p),
  rates: () => request<{ rates: Rate[] }>("GET", "/api/rates"),
  runs: () => request<{ runs: Run[] }>("GET", "/api/runs"),
  run: (id: string) => request<{ run: Run }>("GET", `/api/runs/${id}`),
  startRun: (req: StartRunRequest) => request<{ run: Run }>("POST", "/api/runs", req),
  cancelRun: (id: string) => request<{ ok: true }>("POST", `/api/runs/${id}/cancel`),
};

/** localStorage that never throws (private mode, blocked storage, etc.). */
export const local = {
  get<T>(key: string): T | null {
    try {
      const raw = localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as T) : null;
    } catch {
      return null;
    }
  },
  set(key: string, value: unknown) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // not critical
    }
  },
};
