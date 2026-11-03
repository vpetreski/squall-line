import type { Comparison, Plan, Route } from "../api/schema";
import { LEVELS } from "../api/schema";
import { LEVEL_COLOR, LEVEL_LABEL, LEVEL_SHORT } from "../lib/risk";
import { dayTime, duration, zoneName } from "../lib/time";
import { useStore } from "../state/store";

const mi = (value: number) =>
  value >= 10 ? Math.round(value).toLocaleString("en-US") : value.toFixed(1).replace(/\.0$/, "");

/** Why the recommended route beats this one: the first ranking key on which they differ. */
export function reason(c: Comparison | undefined): string {
  if (!c || c.key === null || c.best === null || c.other === null)
    return "Ties the recommended route on every measure.";
  switch (c.key) {
    case "no_travel_miles":
      return `${mi(c.other)} mi of No Travel, against ${mi(c.best)}.`;
    case "severe_miles":
      return `${mi(c.other)} mi of Severe, against ${mi(c.best)}.`;
    case "high_miles":
      return `${mi(c.other)} mi of High, against ${mi(c.best)}.`;
    case "average_risk":
      return `Average risk ${c.other.toFixed(2)}, against ${c.best.toFixed(2)}.`;
    case "trip_time_s":
      return `Same risk, ${duration(c.other - c.best)} slower.`;
  }
}

/** The route as a strip of its checkpoints, each as wide as the road it stands for. */
export function RiskStrip({ route, height = 8 }: { route: Route; height?: number }) {
  const total = route.distance_mi || 1;
  return (
    <div className="flex w-full overflow-hidden bg-line" style={{ height }} aria-hidden="true">
      {route.checkpoints.map((c) => (
        <div
          key={c.mile}
          style={{ width: `${(c.represents_mi / total) * 100}%`, background: LEVEL_COLOR[c.risk.level] }}
          className="h-full"
        />
      ))}
    </div>
  );
}

function MilesRow({ route }: { route: Route }) {
  return (
    <div className="grid grid-cols-5 gap-px bg-line">
      {LEVELS.map((level) => (
        <div key={level} className="bg-panel px-1.5 py-1.5">
          <div className="flex items-center gap-1 whitespace-nowrap">
            <span className="inline-block size-1.5 shrink-0" style={{ background: LEVEL_COLOR[level] }} />
            <span className="font-mono text-[9px] text-faint uppercase tracking-[0.04em]">{LEVEL_SHORT[level]}</span>
          </div>
          <div className={`num mt-0.5 text-[13px] ${route.miles[level] > 0 ? "text-ink" : "text-faint"}`}>
            {mi(route.miles[level])}
          </div>
        </div>
      ))}
    </div>
  );
}

function RouteCard({ route, plan, comparison }: { route: Route; plan: Plan; comparison?: Comparison }) {
  const selectedId = useStore((s) => s.selectedId);
  const select = useStore((s) => s.select);
  const hover = useStore((s) => s.hover);
  const zone = plan.request.time_zone;
  const selected = route.id === selectedId;
  return (
    <button
      type="button"
      data-testid={`route-${route.id}`}
      aria-pressed={selected}
      onClick={() => select(route.id)}
      onMouseEnter={() => hover(route.id)}
      onMouseLeave={() => hover(null)}
      onFocus={() => hover(route.id)}
      onBlur={() => hover(null)}
      className={`block w-full border text-left transition-colors ${selected ? "border-ink bg-raise" : "border-line-strong bg-panel hover:border-muted"}`}
    >
      <div className="flex items-stretch">
        <div
          className={`display flex w-11 shrink-0 items-center justify-center text-[22px] ${route.recommended ? "bg-ink text-bg" : "border-line-strong border-r text-ink"}`}
        >
          {route.id}
        </div>
        <div className="min-w-0 flex-1 px-3 py-2.5">
          <div className="flex items-baseline justify-between gap-2">
            <span className="label text-ink">{route.recommended ? "Recommended" : `Rank ${route.rank}`}</span>
            <span className="num text-[12px] text-muted">{mi(route.distance_mi)} mi</span>
          </div>
          <div className="mt-1 truncate font-display text-[17px] font-bold [font-stretch:112%]">{route.name}</div>
        </div>
      </div>
      <div className="space-y-2.5 border-line border-t px-3 pt-2.5 pb-3">
        <div className="grid grid-cols-3 gap-2">
          <div>
            <div className="label">Trip</div>
            <div className="num text-[14px]">{duration(route.trip_s)}</div>
          </div>
          <div>
            <div className="label">Driving</div>
            <div className="num text-[14px]">{duration(route.drive_s)}</div>
          </div>
          <div>
            <div className="label">Arrive</div>
            <div className="num text-[14px]">
              {dayTime(route.arrival, zone).slice(4)}{" "}
              <span className="text-[10px] text-faint">{zoneName(route.arrival, zone)}</span>
            </div>
          </div>
        </div>
        <RiskStrip route={route} />
        <MilesRow route={route} />
        <div className="flex items-baseline justify-between gap-2 text-[12px]">
          <span className={route.recommended ? "text-muted" : "text-ink"}>
            {route.recommended ? `Worst: ${LEVEL_LABEL[route.worst]}` : reason(comparison)}
          </span>
          <span className="num shrink-0 text-muted">avg {route.average_risk.toFixed(2)}</span>
        </div>
      </div>
    </button>
  );
}

export function Recommendation({ plan }: { plan: Plan }) {
  const best = plan.routes.find((r) => r.id === plan.recommendation.route_id);
  const runnerUp = plan.recommendation.comparisons[0];
  if (!best) return null;
  return (
    <section
      aria-live="polite"
      className={`border px-4 py-3 ${plan.recommendation.no_safe_route ? "border-no-travel" : "border-ink"}`}
      data-testid="recommendation"
    >
      <div className="label">{plan.recommendation.no_safe_route ? "No safe route" : "Recommendation"}</div>
      <div className="display mt-1.5 text-[26px]">Route {best.id}</div>
      <div className="mt-1 text-[14px] text-ink">{best.name}</div>
      <p className="mt-2 text-[12.5px] text-muted leading-relaxed">
        {plan.recommendation.no_safe_route
          ? `Every route meets No Travel weather. Route ${best.id} has the least of it (${mi(best.miles.no_travel)} mi); a later departure may clear it.`
          : runnerUp
            ? `Next best is route ${runnerUp.route_id}: ${reason(runnerUp).charAt(0).toLowerCase()}${reason(runnerUp).slice(1)}`
            : "The only route found."}
      </p>
    </section>
  );
}

export function RouteCards({ plan }: { plan: Plan }) {
  const byRoute = new Map(plan.recommendation.comparisons.map((c) => [c.route_id, c]));
  return (
    <div className="space-y-2.5">
      {plan.routes.map((route) => (
        <RouteCard key={route.id} route={route} plan={plan} comparison={byRoute.get(route.id)} />
      ))}
      {plan.routes.length < 3 ? (
        <p className="label normal-case tracking-normal">
          Only {plan.routes.length} distinct truck route{plan.routes.length === 1 ? "" : "s"} exist between these
          places.
        </p>
      ) : null}
    </div>
  );
}
