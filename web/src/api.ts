import type { ApiError, Rate, Run, StartRunRequest, Status } from "../../shared/types.ts";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: Partial<ApiError>,
  ) {
    super(body.message || `Request failed (${status})`);
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new HttpError(0, { error: "offline", message: "Can't reach Auto-Park. Check your connection and try again." });
  }
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    const fallback = { error: "http_error", message: res.status >= 500 ? "The server had a problem. Try again in a moment." : `Request failed (${res.status}).` };
    throw new HttpError(res.status, (data && typeof data === "object" ? data : fallback) as ApiError);
  }
  return data as T;
}

export const api = {
  status: () => request<Status>("GET", "/api/status"),
  rates: (engine?: string) => request<{ rates: Rate[] }>("GET", `/api/rates${engine === "fake" ? "?engine=fake" : ""}`),
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
