import { useCallback, useEffect, useState } from "react";
import type { EngineMode, Status } from "../../shared/types.ts";
import { MESSAGES_LOST } from "./messages.ts";
import { api, HttpError } from "./api.ts";
import { Banner, Button, Page, Spinner } from "./components/ui.tsx";
import { useRoute } from "./router.ts";
import { getHistory, recordRun, useProfile } from "./store.ts";
import { History } from "./views/History.tsx";
import { Home } from "./views/Home.tsx";
import { RunView } from "./views/RunView.tsx";
import { Settings } from "./views/Settings.tsx";

function Loading() {
  return (
    <div className="flex min-h-dvh items-center justify-center text-slate-600" role="status">
      <Spinner className="h-8 w-8" />
      <span className="sr-only">Loading</span>
    </div>
  );
}

/** Runs this device saw start but never saw finish (tab closed, phone slept): ask the server how they ended. */
async function reconcileRunning() {
  for (const run of getHistory().filter((r) => r.status === "running")) {
    try {
      const { run: latest } = await api.run(run.id);
      recordRun(latest);
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) {
        recordRun({ ...run, status: "unknown", finishedAt: new Date().toISOString(), outcome: { status: "unknown", message: MESSAGES_LOST } });
      }
    }
  }
}

export function App() {
  const route = useRoute();
  const profile = useProfile();
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    api
      .status()
      .then((s) => {
        setStatus(s);
        void reconcileRunning();
      })
      .catch((err) => setError(err instanceof HttpError ? err.message : "Couldn't reach Auto-Park."));
  }, []);
  useEffect(load, [load]);

  if (error) {
    return (
      <Page title="Auto-Park">
        <Banner tone="error" role="alert" title="Can't reach Auto-Park">
          <p>{error}</p>
          <Button variant="secondary" className="mt-2" onClick={load}>
            Try again
          </Button>
        </Banner>
      </Page>
    );
  }
  if (!status) return <Loading />;

  // A device may have saved a method this server can't run (e.g. the browser engine online).
  const engine: EngineMode = status.engines.includes(profile.engine) ? profile.engine : status.defaultEngine;

  switch (route.name) {
    case "settings":
      return <Settings profile={profile} status={status} engine={engine} />;
    case "history":
      return <History />;
    case "run":
      return <RunView key={route.id} id={route.id} profile={profile} engine={engine} />;
    default:
      return <Home profile={profile} status={status} engine={engine} />;
  }
}
