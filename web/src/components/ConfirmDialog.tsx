import { useEffect, useRef, type ReactNode } from "react";
import { Button } from "./ui.tsx";

/** Modal confirmation built on <dialog>, so focus trapping and Esc work natively. */
export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  cancelLabel = "Cancel",
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      onCancel={(e) => {
        e.preventDefault();
        onCancel();
      }}
      aria-labelledby="confirm-title"
      className="m-auto w-[min(92vw,26rem)] rounded-2xl p-0 shadow-xl backdrop:bg-slate-900/50"
    >
      <div className="p-5">
        <h2 id="confirm-title" className="text-lg font-bold text-slate-900">
          {title}
        </h2>
        <div className="mt-2 text-slate-700">{children}</div>
        <div className="mt-5 flex flex-col gap-2">
          <Button onClick={onConfirm}>{confirmLabel}</Button>
          <Button variant="secondary" onClick={onCancel} autoFocus>
            {cancelLabel}
          </Button>
        </div>
      </div>
    </dialog>
  );
}
