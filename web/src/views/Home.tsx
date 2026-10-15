import { useEffect, useMemo, useRef, useState } from "react";
import { parkedUntil } from "../../../shared/history.ts";
import { shortRateName } from "../../../shared/rates.ts";
import type { EngineMode, Profile, Rate, Status } from "../../../shared/types.ts";
import { maskPhone } from "../../../shared/validate.ts";
import { api, HttpError, local } from "../api.ts";
import { ConfirmDialog } from "../components/ConfirmDialog.tsx";
import { Banner, Button, Card, ChipGroup, Page, Spinner } from "../components/ui.tsx";
import { formatTime, newKey, timeLeft } from "../format.ts";
import { navigate } from "../router.ts";
import { startPurchase } from "../start.ts";
import { saveProfile, useHistory } from "../store.ts";

const RATES_CACHE = "auto-park:rates";

export function useRates(engine: EngineMode) {
  const cacheKey = `${RATES_CACHE}:${engine === "fake" ? "fake" : "live"}`;
  const [rates, setRates] = useState<Rate[] | null>(() => local.get<Rate[]>(cacheKey));
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    api
      .rates(engine)
      .then(({ rates }) => {
        if (!alive) return;
        setRates(rates);
        setError(null);
        local.set(cacheKey, rates);
      })
      .catch((err) => alive && setError(err instanceof HttpError ? err.message : "Couldn't load parking times."))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [engine, cacheKey]);
  return { rates, error, loading };
}

type Pending = { kind: "already_parked"; until: string } | { kind: "maybe_parked"; message: string };

export function Home({ profile, status, engine }: { profile: Profile; status: Status; engine: EngineMode }) {
  const history = useHistory();
  const { rates, error: ratesError, loading: ratesLoading } = useRates(engine);
  const [vehicleId, setVehicleId] = useState(profile.defaultVehicleId ?? profile.vehicles[0]?.id ?? "");
  const [rateName, setRateName] = useState(profile.preferredRate);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  // One key per tap: a double-tap or network retry reuses it, so the server never starts two purchases.
  const tapKey = useRef<string | null>(null);

  const vehicle = profile.vehicles.find((v) => v.id === vehicleId) ?? profile.vehicles[0];
  const needsSetup = !vehicle || !profile.phone;
  const activeRun = history.find((r) => r.status === "running");
  const parked = parkedUntil(history);

  const rateOptions = useMemo(() => {
    if (rates?.length) {
      return rates.map((r) => ({ value: r.name, label: r.shortName, sub: r.requiresPassphrase ? "Needs passphrase" : undefined }));
    }
    if (profile.preferredRate) return [{ value: profile.preferredRate, label: shortRateName(profile.preferredRate) }];
    return [{ value: "", label: "First listed time" }];
  }, [rates, profile.preferredRate]);

  // Fall back to the first listed time if the saved one is no longer offered.
  const rateMissing = !!rates?.length && !rates.some((r) => r.name === rateName);
  useEffect(() => {
    if (rateMissing && rates?.[0]) setRateName(rates[0].name);
  }, [rateMissing, rates]);

  async function park(opts: { force?: boolean } = {}) {
    if (!vehicle) return;
    setBusy(true);
    setError(null);
    setPending(null);
    // Remember this vehicle and time for next time.
    if (vehicle.id !== profile.defaultVehicleId || rateName !== profile.preferredRate) {
      saveProfile({ ...profile, defaultVehicleId: vehicle.id, preferredRate: rateName });
    }
    tapKey.current ??= newKey();
    const result = await startPurchase({ profile, vehicle, rateName, engine, force: opts.force, idempotencyKey: tapKey.current });
    setBusy(false);
    if (result.kind === "started") {
      tapKey.current = null;
      navigate(`/run/${result.run.id}`);
    } else if (result.kind === "already_parked") {
      setPending({ kind: "already_parked", until: result.until });
    } else if (result.kind === "maybe_parked") {
      setPending({ kind: "maybe_parked", message: result.message });
    } else {
      if (!result.offline) tapKey.current = null; // the server answered; a new tap gets a new key
      setError(result.message);
    }
  }

  const simulated = engine === "fake";

  return (
    <Page
      title="Auto-Park"
      actions={
        <nav aria-label="Main" className="flex gap-1">
          <a href="#/history" className="inline-flex min-h-11 items-center rounded-lg px-3 font-medium text-indigo-700 hover:bg-indigo-50">
            History
          </a>
          <a href="#/settings" className="inline-flex min-h-11 items-center rounded-lg px-3 font-medium text-indigo-700 hover:bg-indigo-50">
            Settings
          </a>
        </nav>
      }
    >
      <p className="-mt-3 text-slate-600">{status.lotName} on TapNPark</p>

      {simulated && (
        <Banner tone="info" title="Simulation mode">
          Purchases are simulated. Switch the purchase method in Settings to buy real parking.
        </Banner>
      )}

      {activeRun && (
        <Banner tone="info" title="A purchase is in progress">
          <Button variant="secondary" className="mt-2 w-full" onClick={() => navigate(`/run/${activeRun.id}`)}>
            View progress
          </Button>
        </Banner>
      )}

      {parked && (
        <Banner tone="success" title={`${parked.plate} is parked until ${formatTime(parked.endTime)}`} role="status">
          {timeLeft(parked.endTime)}
        </Banner>
      )}

      {needsSetup ? (
        <Card>
          <h2 className="text-lg font-semibold">Set up your details</h2>
          <p className="mt-1 text-slate-700">
            Add your plate and the phone number for receipts. They're saved only in this browser, on this device, so you only do this once here.
          </p>
          <Button className="mt-4 w-full" onClick={() => navigate("/settings")}>
            Set up
          </Button>
        </Card>
      ) : (
        <Card className="flex flex-col gap-5">
          {profile.vehicles.length > 1 && (
            <ChipGroup
              label="Vehicle"
              value={vehicle!.id}
              onChange={setVehicleId}
              options={profile.vehicles.map((v) => ({ value: v.id, label: v.nickname || v.plate, sub: v.nickname ? v.plate : undefined }))}
            />
          )}

          <div>
            {ratesLoading && !rates ? (
              <p className="flex items-center gap-2 text-slate-600">
                <Spinner className="h-4 w-4" /> Loading parking times…
              </p>
            ) : (
              <ChipGroup label="Parking time" value={rateName} onChange={setRateName} options={rateOptions} />
            )}
            {ratesError && !rates?.length && <p className="mt-2 text-sm text-amber-800">{ratesError} Your saved choice will be used.</p>}
          </div>

          <div>
            <Button className="min-h-16 w-full text-xl" loading={busy} onClick={() => park()} disabled={!!activeRun}>
              {busy ? "Starting…" : `Park ${vehicle!.plate}`}
            </Button>
            <p className="mt-3 text-center text-sm text-slate-600">
              {profile.promoCode ? `Promo ${profile.promoCode}` : "No promo code"} · receipt to {maskPhone(profile.phone)}
            </p>
            <p className="mt-1 text-center text-sm text-slate-600">Nothing is bought unless the total is $0.00.</p>
          </div>

          {error && (
            <Banner tone="error" role="alert">
              {error}
            </Banner>
          )}
        </Card>
      )}

      <p className="text-center text-xs text-slate-600">Your details stay in this browser. Auto-Park's server doesn't keep them.</p>

      <ConfirmDialog
        open={!!pending}
        title={pending?.kind === "already_parked" ? "Already parked" : "Check your texts first"}
        confirmLabel="Buy another session"
        cancelLabel="Don't buy"
        onConfirm={() => park({ force: true })}
        onCancel={() => setPending(null)}
      >
        {pending?.kind === "already_parked" ? (
          <p>
            {vehicle?.plate} is parked until <strong>{formatTime(pending.until)}</strong> ({timeLeft(pending.until)}). Buy another session anyway?
          </p>
        ) : (
          <p>{pending?.message}</p>
        )}
      </ConfirmDialog>
    </Page>
  );
}
