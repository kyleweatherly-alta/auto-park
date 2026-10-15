import { useEffect, useRef, useState } from "react";
import { shortRateName } from "../../../shared/rates.ts";
import { STEPS, type Profile, type Run, type RunEvent, type StepStatus } from "../../../shared/types.ts";
import { formatMoney, maskPhone } from "../../../shared/validate.ts";
import { api, HttpError } from "../api.ts";
import { Banner, Button, Card, cx, Page, Spinner, StatusPill } from "../components/ui.tsx";
import { formatElapsed, formatTime, newKey, timeLeft } from "../format.ts";
import { navigate } from "../router.ts";

function applyEvent(run: Run, e: RunEvent): Run {
  switch (e.type) {
    case "snapshot":
    case "done":
      return e.run;
    case "step":
      return { ...run, steps: run.steps.map((s) => (s.id === e.step ? { ...s, status: e.status, detail: e.detail } : s)) };
    case "log":
      return { ...run, logs: [...(run.logs ?? []), e.message] };
    case "engine":
      return {
        ...run,
        engine: e.engine,
        fellBackFrom: e.fellBackFrom,
        steps: run.steps.map((s) => ({ ...s, status: "pending" as StepStatus, detail: undefined })),
      };
    default:
      return run;
  }
}

/** Follows a run over Server-Sent Events, reconnecting if the phone drops off. */
function useLiveRun(id: string) {
  const [run, setRun] = useState<Run | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reconnecting, setReconnecting] = useState(false);

  useEffect(() => {
    let closed = false;
    let source: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;

    const connect = () => {
      source = new EventSource(`/api/runs/${id}/events`);
      source.onmessage = (msg) => {
        setReconnecting(false);
        const e = JSON.parse(msg.data) as RunEvent;
        setRun((r) => (r || e.type === "snapshot" || e.type === "done" ? applyEvent(r as Run, e) : r));
        if (e.type === "done") {
          closed = true;
          source?.close();
        }
      };
      source.onerror = () => {
        source?.close();
        if (closed) return;
        // The stream ended without "done": the phone slept, or the network blipped. Find out why.
        api
          .run(id)
          .then(({ run }) => {
            setRun(run);
            if (run.status === "running") {
              setReconnecting(true);
              retry = setTimeout(connect, 1500);
            }
          })
          .catch((err) => {
            if (err instanceof HttpError && err.status === 404) setError("This purchase couldn't be found.");
            else {
              setReconnecting(true);
              retry = setTimeout(connect, 3000);
            }
          });
      };
    };
    connect();
    return () => {
      closed = true;
      source?.close();
      clearTimeout(retry);
    };
  }, [id]);

  return { run, error, reconnecting };
}

function StepIcon({ status }: { status: StepStatus }) {
  switch (status) {
    case "done":
      return (
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-emerald-600 text-sm text-white" aria-hidden="true">
          ✓
        </span>
      );
    case "active":
      return <Spinner className="h-6 w-6 text-indigo-700" />;
    case "failed":
      return (
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-red-600 text-sm text-white" aria-hidden="true">
          ✕
        </span>
      );
    case "skipped":
      return (
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-slate-300 text-sm text-slate-700" aria-hidden="true">
          –
        </span>
      );
    default:
      return <span className="h-6 w-6 rounded-full border-2 border-slate-300" aria-hidden="true" />;
  }
}

const stepWord: Record<StepStatus, string> = { pending: "waiting", active: "in progress", done: "done", failed: "failed", skipped: "skipped" };

function Steps({ run }: { run: Run }) {
  return (
    <ol className="flex flex-col gap-1" aria-label="Progress">
      {STEPS.map((def) => {
        const s = run.steps.find((x) => x.id === def.id);
        const status = s?.status ?? "pending";
        return (
          <li
            key={def.id}
            className={cx(
              "flex items-center gap-3 rounded-lg px-2 py-2",
              status === "active" && "bg-indigo-50",
              status === "failed" && "bg-red-50",
            )}
          >
            <StepIcon status={status} />
            <span className={cx("flex-1", status === "pending" ? "text-slate-500" : "text-slate-900", status === "active" && "font-semibold")}>
              {def.label}
              <span className="sr-only">: {stepWord[status]}</span>
            </span>
            {s?.detail && def.id !== "rate" && <span className="max-w-[45%] truncate text-right text-sm text-slate-600">{stepDetail(def.id, s.detail)}</span>}
          </li>
        );
      })}
    </ol>
  );
}

function stepDetail(id: string, detail: string) {
  if (id === "receipt" && /^\d{4}-\d{2}-\d{2}T/.test(detail)) return `until ${formatTime(detail)}`;
  return detail;
}

type Tone = "success" | "info" | "warning" | "error";
const toneFor: Record<string, Tone> = {
  success: "success",
  dry_run_ok: "info",
  already_parked: "info",
  cancelled: "info",
  needs_payment: "warning",
  promo_rejected: "warning",
  lot_mismatch: "warning",
  invalid_plate: "warning",
  rate_unavailable: "warning",
  passphrase_required: "warning",
  unknown: "warning",
  violation: "error",
  timeout: "error",
  error: "error",
};

const titles: Record<string, string> = {
  dry_run_ok: "Test run passed",
  already_parked: "Already parked",
  needs_payment: "Stopped before paying",
  promo_rejected: "Promo code not accepted",
  violation: "Plate in violation",
  lot_mismatch: "Different lot detected",
  invalid_plate: "Plate rejected",
  rate_unavailable: "Parking time unavailable",
  passphrase_required: "Passphrase needed",
  cancelled: "Cancelled",
  timeout: "Timed out",
  unknown: "Check your texts",
  error: "Something went wrong",
};

/** Statuses where trying again can't double-buy. */
const SAFE_RETRY = new Set(["error", "timeout", "cancelled", "promo_rejected", "needs_payment", "rate_unavailable"]);
const FIX_IN_SETTINGS = new Set(["promo_rejected", "needs_payment", "invalid_plate", "rate_unavailable", "passphrase_required"]);

function Result({ run, profile, onRetry, retrying }: { run: Run; profile: Profile; onRetry: (opts?: { allowLotMismatch?: boolean }) => void; retrying: boolean }) {
  const o = run.outcome;
  if (!o) return null;

  if (o.status === "success") {
    return (
      <Card className="text-center">
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-emerald-600 text-3xl text-white" aria-hidden="true">
          ✓
        </div>
        <h2 className="mt-3 text-2xl font-bold text-emerald-800" role="status">
          {o.endTime ? `Parked until ${formatTime(o.endTime)}` : "Parked"}
        </h2>
        {o.endTime && <p className="text-slate-700">{timeLeft(o.endTime)}</p>}
        {!o.endTime && <p className="text-slate-700">{o.message}</p>}
        <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 text-left text-sm">
          <dt className="text-slate-600">Plate</dt>
          <dd className="font-medium">{run.plate}</dd>
          <dt className="text-slate-600">Time bought</dt>
          <dd className="font-medium">{shortRateName(o.rateName ?? run.rateName) || "—"}</dd>
          <dt className="text-slate-600">Paid</dt>
          <dd className="font-medium">{formatMoney(o.amountPaid ?? 0)}</dd>
          <dt className="text-slate-600">Receipt</dt>
          <dd className="font-medium">Texted to {maskPhone(profile.phone)}</dd>
        </dl>
        <Button className="mt-5 w-full" onClick={() => navigate("/", { replace: true })}>
          Done
        </Button>
      </Card>
    );
  }

  const tone = toneFor[o.status] ?? "error";
  return (
    <div className="flex flex-col gap-3">
      <Banner tone={tone} title={titles[o.status] ?? "Finished"} role={tone === "error" || tone === "warning" ? "alert" : "status"}>
        <p>{o.message}</p>
      </Banner>
      {o.status === "lot_mismatch" && (
        <Button loading={retrying} onClick={() => onRetry({ allowLotMismatch: true })}>
          Buy anyway
        </Button>
      )}
      {SAFE_RETRY.has(o.status) && (
        <Button loading={retrying} variant={FIX_IN_SETTINGS.has(o.status) ? "secondary" : "primary"} onClick={() => onRetry()}>
          {run.dryRun ? "Run the test again" : "Try again"}
        </Button>
      )}
      {FIX_IN_SETTINGS.has(o.status) && (
        <Button variant={SAFE_RETRY.has(o.status) ? "primary" : "secondary"} onClick={() => navigate("/settings")}>
          Check settings
        </Button>
      )}
      <Button variant={o.status === "lot_mismatch" || SAFE_RETRY.has(o.status) ? "ghost" : "primary"} onClick={() => navigate("/", { replace: true })}>
        Back to start
      </Button>
    </div>
  );
}

export function RunView({ id, profile }: { id: string; profile: Profile }) {
  const { run, error, reconnecting } = useLiveRun(id);
  const logs = run?.logs ?? [];
  const [now, setNow] = useState(Date.now());
  const [cancelling, setCancelling] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const retryKey = useRef<string | null>(null);
  const running = run?.status === "running";

  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);

  async function cancel() {
    if (!run) return;
    setCancelling(true);
    setActionError(null);
    try {
      await api.cancelRun(run.id);
    } catch (err) {
      setActionError((err as Error).message);
      setCancelling(false);
    }
  }

  async function retry(opts: { allowLotMismatch?: boolean } = {}) {
    if (!run) return;
    const vehicle = profile.vehicles.find((v) => v.plate === run.plate);
    if (!vehicle) {
      setActionError("That vehicle is no longer in your settings.");
      return;
    }
    setRetrying(true);
    setActionError(null);
    retryKey.current ??= newKey();
    try {
      const res = await api.startRun({
        vehicleId: vehicle.id,
        rateName: run.rateName,
        dryRun: run.dryRun,
        allowLotMismatch: opts.allowLotMismatch,
        force: opts.allowLotMismatch,
        idempotencyKey: retryKey.current,
      });
      retryKey.current = null;
      navigate(`/run/${res.run.id}`, { replace: true });
    } catch (err) {
      const e = err as HttpError;
      if (e.status !== 0) retryKey.current = null;
      if (e.body?.error === "busy" && e.body.run) navigate(`/run/${e.body.run.id}`, { replace: true });
      else setActionError(e.message);
    } finally {
      setRetrying(false);
    }
  }

  const checkoutStarted = run?.steps.some((s) => s.id === "checkout" && (s.status === "active" || s.status === "done"));
  const title = run?.dryRun ? "Test run" : running ? "Buying parking" : "Purchase";

  return (
    <Page title={title} back={{ href: "#/", label: "Home" }}>
      {error && <Banner tone="error">{error}</Banner>}
      {!run && !error && (
        <p className="flex items-center gap-2 text-slate-600">
          <Spinner /> Loading…
        </p>
      )}
      {run && (
        <>
          {!running && <Result run={run} profile={profile} onRetry={retry} retrying={retrying} />}

          <Card>
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-lg font-semibold">
                  {run.vehicleName !== run.plate ? `${run.vehicleName} · ` : ""}
                  {run.plate}
                </p>
                <p className="text-slate-600">
                  {shortRateName(run.outcome?.rateName ?? run.rateName) || "First listed time"}
                  {run.dryRun && " · test only, nothing is bought"}
                </p>
              </div>
              <StatusPill status={run.status} />
            </div>
            <div className="mt-4">
              <Steps run={run} />
            </div>
            <p className="mt-3 text-sm text-slate-600" aria-live="polite">
              {running
                ? `${reconnecting ? "Reconnecting… " : ""}${formatElapsed(now - Date.parse(run.createdAt))} elapsed · ${run.engine === "api" ? "fast engine" : run.engine === "browser" ? "browser engine" : "simulation"}`
                : `${formatTime(run.createdAt)} · ${run.engine === "api" ? "fast engine" : run.engine === "browser" ? "browser engine" : "simulation"}`}
            </p>
            {run.fellBackFrom && <p className="mt-1 text-sm text-amber-800">The fast engine failed, so this run switched to the browser engine.</p>}
          </Card>

          {running && (
            <Button variant="danger" onClick={cancel} loading={cancelling} disabled={checkoutStarted}>
              {checkoutStarted ? "Checking out… can't cancel now" : "Cancel"}
            </Button>
          )}

          {actionError && (
            <Banner tone="error" role="alert">
              {actionError}
            </Banner>
          )}

          {(run.hasScreenshot || logs.length > 0) && !running && (
            <details className="rounded-xl bg-white p-4 ring-1 ring-slate-200">
              <summary className="cursor-pointer font-medium text-slate-800">Details</summary>
              {logs.length > 0 && (
                <ul className="mt-2 list-disc pl-5 text-sm text-slate-700">
                  {logs.map((l, i) => (
                    <li key={i}>{l}</li>
                  ))}
                </ul>
              )}
              {run.hasScreenshot && (
                <a href={`/api/runs/${run.id}/screenshot`} target="_blank" rel="noreferrer" className="mt-3 inline-block font-medium text-indigo-700 underline">
                  View TapNPark screenshot
                </a>
              )}
            </details>
          )}
        </>
      )}
    </Page>
  );
}
