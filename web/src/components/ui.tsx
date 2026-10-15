import { useEffect, useId, useRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from "react";
import type { RunStatus } from "../../../shared/types.ts";

export function cx(...parts: (string | false | null | undefined)[]) {
  return parts.filter(Boolean).join(" ");
}

type Variant = "primary" | "secondary" | "danger" | "ghost";

const variants: Record<Variant, string> = {
  primary: "bg-indigo-700 text-white hover:bg-indigo-800 active:bg-indigo-900 disabled:bg-indigo-300",
  secondary: "bg-white text-slate-900 ring-1 ring-inset ring-slate-300 hover:bg-slate-50 active:bg-slate-100 disabled:text-slate-400",
  danger: "bg-white text-red-700 ring-1 ring-inset ring-red-300 hover:bg-red-50 disabled:text-red-300",
  ghost: "text-indigo-700 hover:bg-indigo-50 disabled:text-slate-400",
};

export function Button({
  variant = "primary",
  loading = false,
  className,
  children,
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; loading?: boolean }) {
  return (
    <button
      type="button"
      {...rest}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cx(
        "inline-flex min-h-12 items-center justify-center gap-2 rounded-xl px-4 font-semibold transition-colors disabled:cursor-not-allowed",
        variants[variant],
        className,
      )}
    >
      {loading && <Spinner className="h-5 w-5" />}
      {children}
    </button>
  );
}

export function Spinner({ className = "h-5 w-5" }: { className?: string }) {
  return (
    <svg className={cx("animate-spin", className)} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeOpacity="0.25" strokeWidth="4" />
      <path d="M22 12a10 10 0 0 0-10-10" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />
    </svg>
  );
}

export function Field({
  label,
  hint,
  error,
  className,
  inputClassName,
  ...input
}: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: ReactNode; error?: string; inputClassName?: string }) {
  const id = useId();
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;
  return (
    <div className={className}>
      <label htmlFor={id} className="mb-1 block text-sm font-medium text-slate-700">
        {label}
      </label>
      <input
        id={id}
        {...input}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={cx(
          "block w-full rounded-lg border bg-white px-3 py-2.5 text-base text-slate-900 placeholder:text-slate-500",
          error ? "border-red-500" : "border-slate-300",
          inputClassName,
        )}
      />
      {hint && !error && (
        <p id={`${id}-hint`} className="mt-1 text-sm text-slate-600">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} className="mt-1 text-sm font-medium text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}

type Tone = "info" | "success" | "warning" | "error";

const tones: Record<Tone, string> = {
  info: "bg-indigo-50 text-indigo-950 ring-indigo-200",
  success: "bg-emerald-50 text-emerald-950 ring-emerald-200",
  warning: "bg-amber-50 text-amber-950 ring-amber-300",
  error: "bg-red-50 text-red-950 ring-red-200",
};

export function Banner({ tone = "info", title, children, role }: { tone?: Tone; title?: ReactNode; children?: ReactNode; role?: "status" | "alert" }) {
  return (
    <div role={role} className={cx("rounded-xl p-4 ring-1 ring-inset", tones[tone])}>
      {title && <p className="font-semibold">{title}</p>}
      {children && <div className={cx("text-sm", !!title && "mt-1")}>{children}</div>}
    </div>
  );
}

/** Accessible single-select chips (a radio group styled as pills). */
export function ChipGroup<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { value: T; label: ReactNode; sub?: ReactNode }[];
  value: T;
  onChange: (v: T) => void;
}) {
  const name = useId();
  return (
    <fieldset>
      <legend className="mb-2 text-sm font-medium text-slate-700">{label}</legend>
      <div className="flex flex-wrap gap-2">
        {options.map((o) => (
          <label
            key={o.value}
            className={cx(
              "flex min-h-11 cursor-pointer flex-col justify-center rounded-full px-4 py-1.5 text-sm ring-1 ring-inset transition-colors has-[:focus-visible]:outline has-[:focus-visible]:outline-3 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-indigo-500",
              o.value === value ? "bg-indigo-700 font-semibold text-white ring-indigo-700" : "bg-white text-slate-800 ring-slate-300 hover:bg-slate-50",
            )}
          >
            <input type="radio" name={name} value={o.value} checked={o.value === value} onChange={() => onChange(o.value)} className="sr-only" />
            <span>{o.label}</span>
            {o.sub && <span className={cx("text-xs", o.value === value ? "text-indigo-100" : "text-slate-600")}>{o.sub}</span>}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function Page({ title, back, actions, children }: { title: string; back?: { href: string; label: string }; actions?: ReactNode; children: ReactNode }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    // Move focus to the new screen's heading so screen readers announce it.
    heading.current?.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }, [title]);
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-md flex-col px-4 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-[max(0.75rem,env(safe-area-inset-top))]">
      <header className="mb-4 flex min-h-12 items-center gap-2">
        {back && (
          <a href={back.href} className="-ml-2 inline-flex min-h-11 items-center rounded-lg px-2 font-medium text-indigo-700 hover:bg-indigo-50">
            <span aria-hidden="true">‹&nbsp;</span>
            {back.label}
          </a>
        )}
        <h1 ref={heading} tabIndex={-1} className={cx("text-xl font-bold outline-none", back ? "sr-only" : "flex-1")}>
          {title}
        </h1>
        {back && (
          <p aria-hidden="true" className="flex-1 text-center text-lg font-semibold">
            {title}
          </p>
        )}
        {actions ?? (back && <span className="w-16" />)}
      </header>
      <main className="flex flex-1 flex-col gap-4">{children}</main>
    </div>
  );
}

const statusStyles: Record<string, { label: string; className: string }> = {
  running: { label: "In progress", className: "bg-indigo-100 text-indigo-900" },
  queued: { label: "Starting", className: "bg-indigo-100 text-indigo-900" },
  success: { label: "Parked", className: "bg-emerald-100 text-emerald-900" },
  dry_run_ok: { label: "Test passed", className: "bg-sky-100 text-sky-900" },
  already_parked: { label: "Already parked", className: "bg-slate-200 text-slate-900" },
  needs_payment: { label: "Not free", className: "bg-amber-100 text-amber-950" },
  promo_rejected: { label: "Promo rejected", className: "bg-amber-100 text-amber-950" },
  violation: { label: "Violation", className: "bg-red-100 text-red-900" },
  lot_mismatch: { label: "Lot mismatch", className: "bg-amber-100 text-amber-950" },
  invalid_plate: { label: "Bad plate", className: "bg-amber-100 text-amber-950" },
  rate_unavailable: { label: "Time unavailable", className: "bg-amber-100 text-amber-950" },
  passphrase_required: { label: "Needs passphrase", className: "bg-amber-100 text-amber-950" },
  cancelled: { label: "Cancelled", className: "bg-slate-200 text-slate-900" },
  timeout: { label: "Timed out", className: "bg-red-100 text-red-900" },
  unknown: { label: "Check texts", className: "bg-amber-100 text-amber-950" },
  error: { label: "Failed", className: "bg-red-100 text-red-900" },
};

export function StatusPill({ status }: { status: RunStatus }) {
  const s = statusStyles[status] ?? { label: status, className: "bg-slate-200 text-slate-900" };
  return <span className={cx("inline-block rounded-full px-2.5 py-0.5 text-xs font-semibold", s.className)}>{s.label}</span>;
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <section className={cx("rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200", className)}>{children}</section>;
}
