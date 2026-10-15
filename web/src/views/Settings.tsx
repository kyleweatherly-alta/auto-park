import { useMemo, useState, type FormEvent } from "react";
import type { EngineMode, Profile, Vehicle } from "../../../shared/types.ts";
import { formatPhone, normalizeNickname, normalizePhone, normalizePlate, normalizePromo } from "../../../shared/validate.ts";
import { api, HttpError } from "../api.ts";
import { Banner, Button, Card, cx, Field, Page } from "../components/ui.tsx";
import { newKey } from "../format.ts";
import { navigate } from "../router.ts";
import { useRates } from "./Home.tsx";

type Draft = {
  vehicles: (Vehicle & { key: string })[];
  defaultVehicleId: string | null;
  phone: string;
  promoCode: string;
  preferredRate: string;
  engine: EngineMode;
};

const ENGINES: { value: EngineMode; label: string; hint: string }[] = [
  { value: "auto", label: "Automatic (recommended)", hint: "Fast API first; switches to the browser if TapNPark changed something." },
  { value: "api", label: "Fast only", hint: "TapNPark's API directly. A few seconds." },
  { value: "browser", label: "Browser only", hint: "Taps through TapNPark's website. A few seconds slower." },
  { value: "fake", label: "Simulation", hint: "Never contacts TapNPark or buys anything. For trying the app." },
];

function toDraft(p: Profile): Draft {
  return {
    vehicles: p.vehicles.length ? p.vehicles.map((v) => ({ ...v, key: v.id })) : [{ id: "", plate: "", nickname: "", key: newKey() }],
    defaultVehicleId: p.defaultVehicleId,
    phone: p.phone ? formatPhone(p.phone) : "",
    promoCode: p.promoCode,
    preferredRate: p.preferredRate,
    engine: p.engine,
  };
}

/** After React re-renders with errors, move focus to the first invalid field. */
function focusFirstError() {
  requestAnimationFrame(() => document.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus());
}

function validate(d: Draft): Record<string, string> {
  const errors: Record<string, string> = {};
  const seen = new Set<string>();
  d.vehicles.forEach((v, i) => {
    const plate = normalizePlate(v.plate);
    if (!plate.ok) errors[`vehicles.${i}.plate`] = plate.error;
    else if (seen.has(plate.value)) errors[`vehicles.${i}.plate`] = "This plate is already listed.";
    else seen.add(plate.value);
    const nick = normalizeNickname(v.nickname);
    if (!nick.ok) errors[`vehicles.${i}.nickname`] = nick.error;
  });
  const phone = normalizePhone(d.phone);
  if (!phone.ok) errors.phone = phone.error;
  const promo = normalizePromo(d.promoCode);
  if (!promo.ok) errors.promoCode = promo.error;
  return errors;
}

export function Settings({ profile, onProfile }: { profile: Profile; onProfile: (p: Profile) => void }) {
  const [draft, setDraft] = useState<Draft>(() => toDraft(profile));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const { rates } = useRates();
  const firstRun = profile.vehicles.length === 0 || !profile.phone;

  const dirty = useMemo(() => JSON.stringify(toDraft(profile)) !== JSON.stringify(draft), [profile, draft]);
  const liveErrors = useMemo(() => validate(draft), [draft]);
  const shown = (key: string) => errors[key] ?? (touched[key] ? liveErrors[key] : undefined);

  function update(patch: Partial<Draft>) {
    setDraft((d) => ({ ...d, ...patch }));
    setSaved(false);
  }
  function updateVehicle(i: number, patch: Partial<Vehicle>) {
    setDraft((d) => ({ ...d, vehicles: d.vehicles.map((v, j) => (j === i ? { ...v, ...patch } : v)) }));
    setErrors((e) => {
      const { [`vehicles.${i}.plate`]: _a, [`vehicles.${i}.nickname`]: _b, ...rest } = e;
      return rest;
    });
    setSaved(false);
  }
  const touch = (key: string) => setTouched((t) => ({ ...t, [key]: true }));

  async function save(e: FormEvent) {
    e.preventDefault();
    const v = validate(draft);
    setErrors(v);
    setFormError(null);
    if (Object.keys(v).length) {
      setFormError("Please fix the highlighted fields.");
      focusFirstError();
      return;
    }
    setSaving(true);
    try {
      const next = await api.saveProfile({
        vehicles: draft.vehicles.map(({ key: _k, ...rest }) => rest),
        defaultVehicleId: draft.defaultVehicleId,
        phone: draft.phone,
        promoCode: draft.promoCode,
        preferredRate: draft.preferredRate,
        engine: draft.engine,
      });
      onProfile(next);
      setDraft(toDraft(next));
      setTouched({});
      setSaved(true);
      if (firstRun) navigate("/", { replace: true });
    } catch (err) {
      const he = err as HttpError;
      if (he.body?.fields) {
        setErrors(he.body.fields);
        focusFirstError();
      }
      setFormError(he.message);
    } finally {
      setSaving(false);
    }
  }

  async function testRun() {
    const vehicleId = profile.defaultVehicleId ?? profile.vehicles[0]?.id;
    if (!vehicleId) return;
    setTesting(true);
    setFormError(null);
    try {
      const { run } = await api.startRun({ vehicleId, rateName: profile.preferredRate, dryRun: true, idempotencyKey: newKey() });
      navigate(`/run/${run.id}`);
    } catch (err) {
      const he = err as HttpError;
      if (he.body?.error === "busy" && he.body.run) navigate(`/run/${he.body.run.id}`);
      else setFormError(he.message);
      setTesting(false);
    }
  }

  async function signOut() {
    try {
      await api.logout();
    } finally {
      window.location.hash = "";
      window.location.reload();
    }
  }

  const rateChoices = rates?.length ? rates : profile.preferredRate ? [{ name: profile.preferredRate, shortName: profile.preferredRate }] : [];

  return (
    <Page title={firstRun ? "Set up" : "Settings"} back={firstRun ? undefined : { href: "#/", label: "Home" }}>
      <form onSubmit={save} noValidate className="flex flex-col gap-4">
        <Card className="flex flex-col gap-4">
          <h2 className="text-lg font-semibold">Vehicles</h2>
          {draft.vehicles.map((v, i) => (
            <div key={v.key} className={cx("flex flex-col gap-3", i > 0 && "border-t border-slate-200 pt-4")}>
              <div className="grid grid-cols-2 gap-3">
                <Field
                  label="License plate"
                  value={v.plate}
                  onChange={(e) => updateVehicle(i, { plate: e.target.value.toUpperCase() })}
                  onBlur={() => touch(`vehicles.${i}.plate`)}
                  error={shown(`vehicles.${i}.plate`)}
                  autoCapitalize="characters"
                  autoCorrect="off"
                  spellCheck={false}
                  placeholder="ABC1234"
                  inputClassName="font-semibold uppercase tracking-wide"
                />
                <Field
                  label="Nickname"
                  value={v.nickname}
                  onChange={(e) => updateVehicle(i, { nickname: e.target.value })}
                  onBlur={() => touch(`vehicles.${i}.nickname`)}
                  error={shown(`vehicles.${i}.nickname`)}
                  placeholder="Optional"
                />
              </div>
              {draft.vehicles.length > 1 && (
                <div className="flex items-center justify-between">
                  <label className="inline-flex min-h-11 items-center gap-2 text-slate-800">
                    <input
                      type="radio"
                      name="default-vehicle"
                      className="h-5 w-5 accent-indigo-700"
                      checked={draft.defaultVehicleId === v.id || (!draft.defaultVehicleId && i === 0)}
                      onChange={() => update({ defaultVehicleId: v.id || null })}
                      disabled={!v.id}
                    />
                    Default
                  </label>
                  <Button variant="ghost" onClick={() => update({ vehicles: draft.vehicles.filter((_, j) => j !== i) })}>
                    Remove
                  </Button>
                </div>
              )}
            </div>
          ))}
          {draft.vehicles.length < 10 && (
            <Button variant="secondary" onClick={() => update({ vehicles: [...draft.vehicles, { id: "", plate: "", nickname: "", key: newKey() }] })}>
              Add a vehicle
            </Button>
          )}
          {errors.vehicles && <p className="text-sm font-medium text-red-700">{errors.vehicles}</p>}
        </Card>

        <Card className="flex flex-col gap-4">
          <h2 className="text-lg font-semibold">Purchase details</h2>
          <Field
            label="Phone for receipts"
            type="tel"
            inputMode="tel"
            autoComplete="tel-national"
            value={draft.phone}
            onChange={(e) => update({ phone: e.target.value })}
            onBlur={() => {
              touch("phone");
              const p = normalizePhone(draft.phone);
              if (p.ok) update({ phone: formatPhone(p.value) });
            }}
            error={shown("phone")}
            placeholder="(555) 555-1234"
            hint="TapNPark texts the receipt here."
          />
          <Field
            label="Promo / validation code"
            value={draft.promoCode}
            onChange={(e) => update({ promoCode: e.target.value.toUpperCase() })}
            onBlur={() => touch("promoCode")}
            error={shown("promoCode")}
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            placeholder="Optional"
            hint="Applied at checkout. Auto-Park only buys if the total comes to $0.00."
          />
          <div>
            <label htmlFor="default-rate" className="mb-1 block text-sm font-medium text-slate-700">
              Default parking time
            </label>
            <select
              id="default-rate"
              value={draft.preferredRate}
              onChange={(e) => update({ preferredRate: e.target.value })}
              className="block min-h-11 w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-base"
            >
              <option value="">First listed time</option>
              {rateChoices.map((r) => (
                <option key={r.name} value={r.name}>
                  {r.shortName}
                </option>
              ))}
            </select>
            <p className="mt-1 text-sm text-slate-600">You can still change it on the main screen before each purchase.</p>
          </div>
        </Card>

        <Card>
          <fieldset>
            <legend className="text-lg font-semibold">Purchase method</legend>
            <div className="mt-3 flex flex-col gap-2">
              {ENGINES.map((e) => (
                <label
                  key={e.value}
                  className={cx(
                    "flex cursor-pointer gap-3 rounded-xl p-3 ring-1 ring-inset",
                    draft.engine === e.value ? "bg-indigo-50 ring-indigo-300" : "ring-slate-200 hover:bg-slate-50",
                  )}
                >
                  <input
                    type="radio"
                    name="engine"
                    value={e.value}
                    checked={draft.engine === e.value}
                    onChange={() => update({ engine: e.value })}
                    className="mt-1 h-5 w-5 shrink-0 accent-indigo-700"
                  />
                  <span>
                    <span className="block font-medium text-slate-900">{e.label}</span>
                    <span className="block text-sm text-slate-600">{e.hint}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
        </Card>

        {formError && (
          <Banner tone="error" role="alert">
            {formError}
          </Banner>
        )}
        {saved && !dirty && (
          <Banner tone="success" role="status">
            Saved.
          </Banner>
        )}
        <Button type="submit" loading={saving} disabled={!dirty && !firstRun} className="min-h-14 text-lg">
          {firstRun ? "Save and continue" : dirty ? "Save changes" : "No changes to save"}
        </Button>
      </form>

      {!firstRun && (
        <Card className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold">Test run</h2>
          <p className="text-slate-700">Goes through the whole purchase on TapNPark and stops right before checkout, so you can check the promo still makes it free. Nothing is bought.</p>
          <Button variant="secondary" onClick={testRun} loading={testing} disabled={dirty}>
            Run a test
          </Button>
          {dirty && <p className="text-sm text-slate-600">Save your changes first.</p>}
        </Card>
      )}

      <Button variant="ghost" onClick={signOut} className="self-center">
        Sign out of this device
      </Button>
    </Page>
  );
}
