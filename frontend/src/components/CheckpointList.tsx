import type { Plan, Route } from "../api/schema";
import { LEVEL_COLOR, LEVEL_LABEL, LEVEL_SHORT } from "../lib/risk";
import { clock, dayTime, duration, weekdayClock } from "../lib/time";
import { useStore } from "../state/store";

type Row =
  | { kind: "checkpoint"; index: number; mile: number }
  | { kind: "stop"; stop: Route["stops"][number]; mile: number };

function hoursAfter(plan: Plan, iso: string): number {
  const h = (Date.parse(iso) - Date.parse(plan.request.departure)) / 3_600_000;
  return Math.min(Math.max(h, 0), plan.corridor.frames - 1);
}

/** Every checkpoint of the selected route at its arrival time, with the stops in between and the hazards first. */
export function CheckpointList({ plan }: { plan: Plan }) {
  const selectedId = useStore((s) => s.selectedId);
  const focus = useStore((s) => s.focus);
  const setFocus = useStore((s) => s.setFocus);
  const setHours = useStore((s) => s.setHours);
  const route = plan.routes.find((r) => r.id === selectedId);
  if (!route) return null;
  const zone = plan.request.time_zone;

  const rows: Row[] = [
    ...route.checkpoints.map((c, index) => ({ kind: "checkpoint" as const, index, mile: c.mile })),
    ...route.stops.map((stop) => ({ kind: "stop" as const, stop, mile: stop.mile + 0.001 })),
  ].sort((a, b) => a.mile - b.mile);

  const jump = (index: number) => {
    const c = route.checkpoints[index];
    if (!c) return;
    setFocus({ routeId: route.id, index, pinned: true });
    setHours(hoursAfter(plan, c.eta));
  };

  return (
    <section aria-label={`Checkpoints of route ${route.id}`} data-testid="checkpoints">
      <div className="mb-2 flex items-baseline justify-between">
        <h2 className="label text-ink">
          Route {route.id} · {route.checkpoints.length} checkpoints
        </h2>
        <span className="label normal-case tracking-normal">every {plan.request.interval_mi} mi</span>
      </div>

      {route.hazards.length > 0 ? (
        <div className="mb-3 space-y-1">
          {route.hazards.map((h) => {
            const first = route.checkpoints.findIndex((c) => c.eta === h.from_eta);
            return (
              <button
                key={`${h.from_mile}-${h.level}`}
                type="button"
                onClick={() => jump(Math.max(first, 0))}
                className="flex w-full items-center gap-2.5 border border-line-strong bg-panel px-2.5 py-2 text-left hover:border-muted"
              >
                <span className="h-7 w-1 shrink-0" style={{ background: LEVEL_COLOR[h.level] }} />
                <span className="min-w-0 flex-1">
                  <span className="num block text-[12.5px] text-ink">
                    {LEVEL_LABEL[h.level]} · mi {Math.round(h.from_mile)}–{Math.round(h.to_mile)}
                  </span>
                  <span className="label block normal-case tracking-normal">
                    {dayTime(h.from_eta, zone)}–{clock(h.to_eta, zone)} · {h.causes.join(", ")}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      ) : (
        <p className="mb-3 border border-line px-2.5 py-2 text-[12.5px] text-muted">
          Nothing High or worse along this route at the times the truck passes.
        </p>
      )}

      <div className="border border-line">
        <div className="label grid grid-cols-[3.2rem_4.6rem_1fr_3.4rem_3.4rem_4.2rem] gap-1 border-line border-b bg-panel px-2 py-1.5">
          <span>Mile</span>
          <span>ETA</span>
          <span>Wind</span>
          <span>Rain</span>
          <span>Snow</span>
          <span className="text-right">Risk</span>
        </div>
        <div className="scroll-thin max-h-[420px] overflow-y-auto">
          {rows.map((row) => {
            if (row.kind === "stop") {
              const s = row.stop;
              const length = (Date.parse(s.end) - Date.parse(s.start)) / 1000;
              return (
                <div
                  key={`stop-${s.start}`}
                  className="num flex items-center gap-2 border-line border-b bg-bg px-2 py-1.5 text-[11.5px] text-muted"
                >
                  <span className="border border-line-strong px-1 text-[9.5px] text-ink">
                    {s.kind === "rest" ? "REST" : "BREAK"}
                  </span>
                  <span>
                    {duration(length)} at mi {Math.round(s.mile)} · {clock(s.start, zone)}–{clock(s.end, zone)}
                  </span>
                </div>
              );
            }
            const c = route.checkpoints[row.index];
            if (!c) return null;
            const active = focus?.routeId === route.id && focus.index === row.index;
            return (
              <button
                key={`cp-${row.index}`}
                type="button"
                onMouseEnter={() => {
                  if (!useStore.getState().focus?.pinned)
                    setFocus({ routeId: route.id, index: row.index, pinned: false });
                }}
                onClick={() => jump(row.index)}
                className={`num grid w-full grid-cols-[3.2rem_4.6rem_1fr_3.4rem_3.4rem_4.2rem] items-center gap-1 border-line border-b px-2 py-1.5 text-left text-[12px] last:border-b-0 hover:bg-raise ${active ? "bg-raise" : ""}`}
                style={{ boxShadow: c.risk.level === "low" ? undefined : `inset 3px 0 0 ${LEVEL_COLOR[c.risk.level]}` }}
              >
                <span className="text-muted">{Math.round(c.mile)}</span>
                <span>{weekdayClock(c.eta, zone)}</span>
                <span>
                  {c.weather.wind_mph.toFixed(0)}
                  <span className="text-faint">/{c.weather.gust_mph.toFixed(0)}</span>
                </span>
                <span className={c.weather.rain_in_hr > 0 ? "" : "text-faint"}>{c.weather.rain_in_hr.toFixed(2)}</span>
                <span className={c.weather.snow_in_hr > 0 ? "" : "text-faint"}>{c.weather.snow_in_hr.toFixed(2)}</span>
                <span className="flex items-center justify-end gap-1.5">
                  <span className="text-[10px] tracking-wider">{LEVEL_SHORT[c.risk.level]}</span>
                  <span className="inline-block size-2" style={{ background: LEVEL_COLOR[c.risk.level] }} />
                </span>
              </button>
            );
          })}
        </div>
      </div>
      <p className="label mt-1.5 normal-case tracking-normal">
        Wind and gusts in mph; rain and snow in in/hr at the ETA.
      </p>
    </section>
  );
}
