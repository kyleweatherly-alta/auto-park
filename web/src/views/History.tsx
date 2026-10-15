import { useEffect, useState } from "react";
import { shortRateName } from "../../../shared/rates.ts";
import type { Run } from "../../../shared/types.ts";
import { api, HttpError } from "../api.ts";
import { Banner, Button, Card, Page, Spinner, StatusPill } from "../components/ui.tsx";
import { formatTime } from "../format.ts";

export function History() {
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    setError(null);
    api
      .runs()
      .then(({ runs }) => alive && setRuns(runs))
      .catch((err) => alive && setError(err instanceof HttpError ? err.message : "Couldn't load history."));
    return () => {
      alive = false;
    };
  }, [attempt]);

  return (
    <Page title="History" back={{ href: "#/", label: "Home" }}>
      {error && (
        <Banner tone="error" role="alert" title="Couldn't load history">
          <p>{error}</p>
          <Button variant="secondary" className="mt-2" onClick={() => setAttempt((a) => a + 1)}>
            Try again
          </Button>
        </Banner>
      )}
      {!runs && !error && (
        <p className="flex items-center gap-2 text-slate-600">
          <Spinner /> Loading…
        </p>
      )}
      {runs?.length === 0 && (
        <Card className="text-center">
          <p className="font-medium">No purchases yet</p>
          <p className="mt-1 text-slate-600">Each purchase and test run will show up here.</p>
        </Card>
      )}
      {runs && runs.length > 0 && (
        <ul className="flex flex-col gap-2">
          {runs.map((r) => (
            <li key={r.id}>
              <a href={`#/run/${r.id}`} className="block rounded-xl bg-white p-4 ring-1 ring-slate-200 hover:bg-slate-50">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold">
                    {r.plate}
                    {r.dryRun && <span className="ml-2 text-sm font-normal text-slate-600">test</span>}
                  </span>
                  <StatusPill status={r.status} />
                </div>
                <p className="mt-1 text-sm text-slate-700">
                  {formatTime(r.createdAt)} · {shortRateName(r.outcome?.rateName ?? r.rateName) || "First listed time"}
                </p>
                {r.status === "success" && r.outcome?.endTime && <p className="text-sm text-emerald-800">Until {formatTime(r.outcome.endTime)}</p>}
                {r.status !== "success" && r.outcome?.message && <p className="line-clamp-2 text-sm text-slate-600">{r.outcome.message}</p>}
              </a>
            </li>
          ))}
        </ul>
      )}
    </Page>
  );
}
