import { useState, type FormEvent } from "react";
import { api, HttpError } from "../api.ts";
import { Banner, Button, Field, Page } from "../components/ui.tsx";

export function Login({ onDone }: { onDone: () => void }) {
  const [passcode, setPasscode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!passcode.trim()) {
      setError("Enter your passcode.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.login(passcode);
      onDone();
    } catch (err) {
      setError(err instanceof HttpError ? err.message : "Couldn't sign in. Try again.");
      setBusy(false);
    }
  }

  return (
    <Page title="Auto-Park">
      <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <p className="text-slate-700">Enter your passcode to unlock one-tap parking on this device. You'll stay signed in for 90 days.</p>
        <Field
          label="Passcode"
          type="password"
          autoComplete="current-password"
          value={passcode}
          onChange={(e) => setPasscode(e.target.value)}
          error={error ?? undefined}
          autoFocus
        />
        <Button type="submit" loading={busy} className="min-h-14 text-lg">
          Unlock
        </Button>
      </form>
      {error?.startsWith("Too many") && <Banner tone="warning">Wait a few minutes before trying again.</Banner>}
    </Page>
  );
}
