import { shortRateName } from "../../../shared/rates.ts";
import { Card, Page, StatusPill } from "../components/ui.tsx";
import { formatTime } from "../format.ts";
import { useHistory } from "../store.ts";

export function History() {
  const runs = useHistory();

  return (
    <Page title="History" back={{ href: "#/", label: "Home" }}>
      {runs.length === 0 ? (
        <Card className="text-center">
          <p className="font-medium">No purchases yet</p>
          <p className="mt-1 text-slate-600">Purchases and test runs made from this device will show up here.</p>
        </Card>
      ) : (
        <>
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
          <p className="text-center text-xs text-slate-600">Only purchases made from this device are listed.</p>
        </>
      )}
    </Page>
  );
}
