import { useCallback, useEffect, useState } from "react";
import type { Profile } from "../../shared/types.ts";
import { api, HttpError, onUnauthorized } from "./api.ts";
import { Banner, Button, Page, Spinner } from "./components/ui.tsx";
import { useRoute } from "./router.ts";
import { History } from "./views/History.tsx";
import { Home } from "./views/Home.tsx";
import { Login } from "./views/Login.tsx";
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

export function App() {
  const [auth, setAuth] = useState<"loading" | "in" | "out">("loading");

  useEffect(() => {
    api
      .session()
      .then((s) => setAuth(s.authenticated ? "in" : "out"))
      .catch(() => setAuth("out"));
    const out = () => setAuth("out");
    onUnauthorized.addEventListener("unauthorized", out);
    return () => onUnauthorized.removeEventListener("unauthorized", out);
  }, []);

  if (auth === "loading") return <Loading />;
  if (auth === "out") return <Login onDone={() => setAuth("in")} />;
  return <Authed />;
}

function Authed() {
  const route = useRoute();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    api
      .profile()
      .then(setProfile)
      .catch((err) => setError(err instanceof HttpError ? err.message : "Couldn't load your details."));
  }, []);
  useEffect(load, [load]);

  if (error) {
    return (
      <Page title="Auto-Park">
        <Banner tone="error" role="alert" title="Couldn't load your details">
          <p>{error}</p>
          <Button variant="secondary" className="mt-2" onClick={load}>
            Try again
          </Button>
        </Banner>
      </Page>
    );
  }
  if (!profile) return <Loading />;

  switch (route.name) {
    case "settings":
      return <Settings profile={profile} onProfile={setProfile} />;
    case "history":
      return <History />;
    case "run":
      return <RunView key={route.id} id={route.id} profile={profile} />;
    default:
      return <Home profile={profile} onProfile={setProfile} />;
  }
}
