import { useEffect, useState } from "react";
import { useStore } from "../state/store";

const STAGE_TEXT = {
  planning: "Routing three truck routes, timing every checkpoint, reading the forecast at each ETA.",
  relaying:
    "The server's share of the free forecast quota is used up for the minute, so your browser is fetching the forecast directly.",
  assessing: "Scoring the routes on the forecast your browser fetched.",
} as const;

export function Status() {
  const status = useStore((s) => s.status);
  const startedAt = useStore((s) => s.startedAt);
  const error = useStore((s) => s.error);
  const run = useStore((s) => s.run);
  const [now, setNow] = useState(() => performance.now());
  const busy = status === "planning" || status === "relaying" || status === "assessing";

  useEffect(() => {
    if (!busy) return;
    const t = window.setInterval(() => setNow(performance.now()), 100);
    return () => window.clearInterval(t);
  }, [busy]);

  if (busy) {
    const seconds = Math.max(0, (now - startedAt) / 1000);
    return (
      <div className="border border-line-strong" role="status" aria-live="polite" data-testid="status">
        <div className="h-0.5 w-full overflow-hidden bg-line">
          <div className="h-full w-1/3 animate-[slide_1.1s_ease-in-out_infinite] bg-ink" />
        </div>
        <div className="flex items-start justify-between gap-3 px-3 py-2.5">
          <p className="text-[12.5px] text-muted leading-relaxed">{STAGE_TEXT[status]}</p>
          <span className="num shrink-0 text-[13px] text-ink">{seconds.toFixed(1)} s</span>
        </div>
      </div>
    );
  }
  if (status === "error" && error) {
    return (
      <div className="border border-severe px-3 py-2.5" role="alert" data-testid="error">
        <div className="label text-severe">{error.code.replaceAll("_", " ")}</div>
        <p className="mt-1 text-[13px] text-ink">{error.message}</p>
        {Object.keys(error.fields).length > 0 ? (
          <ul className="mt-1.5 space-y-0.5">
            {Object.entries(error.fields).map(([field, message]) => (
              <li key={field} className="num text-[11.5px] text-muted">
                {field}: {message}
              </li>
            ))}
          </ul>
        ) : null}
        <button type="button" className="btn-ghost mt-2.5 text-ink" onClick={() => void run()}>
          Try again
        </button>
      </div>
    );
  }
  return null;
}
