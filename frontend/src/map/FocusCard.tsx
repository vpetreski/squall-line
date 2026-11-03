import type { Map as MapLibre } from "maplibre-gl";
import { useEffect, useState } from "react";
import { useDecimals } from "../api/hooks";
import type { Level, Plan } from "../api/schema";
import { LEVEL_COLOR, LEVEL_LABEL, LOAD_RULE_TEXT } from "../lib/risk";
import { dayTime, zoneName } from "../lib/time";
import { describeWeather } from "../lib/weatherCodes";
import { useStore } from "../state/store";

const WIDTH = 288;

function Badge({ level }: { level: Level }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="inline-block size-2.5" style={{ background: LEVEL_COLOR[level] }} />
      <span className="num text-[11px] font-semibold uppercase tracking-wider">{LEVEL_LABEL[level]}</span>
    </span>
  );
}

function Row({ name, value, level }: { name: string; value: string; level?: Level }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-line border-t py-1.5 first:border-t-0">
      <span className="label">{name}</span>
      <span className="num flex items-center gap-2 text-[12.5px] text-ink">
        {value}
        {level && level !== "low" ? (
          <span className="inline-block size-2" style={{ background: LEVEL_COLOR[level] }} title={LEVEL_LABEL[level]} />
        ) : null}
      </span>
    </div>
  );
}

/** The weather and the verdict at one checkpoint, at the moment the truck reaches it. */
export function FocusCard({ map, plan }: { map: MapLibre; plan: Plan }) {
  const focus = useStore((s) => s.focus);
  const setFocus = useStore((s) => s.setFocus);
  const decimals = useDecimals();
  const [, redraw] = useState(0);

  useEffect(() => {
    const move = () => redraw((n) => n + 1);
    map.on("move", move);
    return () => {
      map.off("move", move);
    };
  }, [map]);

  if (!focus) return null;
  const route = plan.routes.find((r) => r.id === focus.routeId);
  const c = route?.checkpoints[focus.index];
  if (!route || !c) return null;

  const zone = plan.request.time_zone;
  const point = map.project([c.lon, c.lat]);
  const box = map.getContainer();
  const left = point.x + 18 + WIDTH > box.clientWidth ? point.x - 18 - WIDTH : point.x + 18;
  const top = Math.min(Math.max(point.y - 70, 12), box.clientHeight - 330);
  const local =
    c.time_zone !== zone ? `${dayTime(c.eta, c.time_zone).slice(-5)} ${zoneName(c.eta, c.time_zone)} local` : null;
  const w = c.weather;
  const r = c.risk;

  return (
    <div
      className={`absolute z-20 border border-line-strong bg-panel/95 shadow-[6px_6px_0_rgba(0,0,0,0.6)] backdrop-blur-sm ${focus.pinned ? "" : "pointer-events-none"}`}
      style={{ left, top, width: WIDTH }}
      data-testid="focus-card"
    >
      <div className="flex items-center justify-between border-line border-b px-3 py-2">
        <span className="label text-ink">
          Route {route.id} · mile {Math.round(c.mile)}
        </span>
        {focus.pinned ? (
          <button
            type="button"
            className="num -mr-1 px-1 text-muted hover:text-ink"
            aria-label="Close"
            onClick={() => setFocus(null)}
          >
            ✕
          </button>
        ) : (
          <span className="label text-faint">
            {focus.index + 1}/{route.checkpoints.length}
          </span>
        )}
      </div>
      <div className="space-y-2.5 px-3 py-2.5">
        <div className="flex items-start justify-between gap-2">
          <div>
            <div className="num text-[15px] text-ink">
              {dayTime(c.eta, zone)} <span className="text-muted text-xs">{zoneName(c.eta, zone)}</span>
            </div>
            <div className="label mt-0.5 normal-case tracking-normal">
              {local ? `${local} · ` : ""}forecast +{Math.max(0, Math.round(c.lead_h))} h
            </div>
          </div>
          <Badge level={r.level} />
        </div>
        <div>
          <Row name="Wind" value={`${w.wind_mph.toFixed(decimals.wind)} mph`} level={r.wind} />
          <Row name="Gusts" value={`${w.gust_mph.toFixed(0)} mph`} />
          <Row name="Rain" value={`${w.rain_in_hr.toFixed(decimals.rain)} in/hr`} level={r.rain} />
          <Row name="Snow" value={`${w.snow_in_hr.toFixed(decimals.snow)} in/hr`} level={r.snow} />
          <Row name="Sky" value={`${describeWeather(w.code)} · ${Math.round(w.temp_f)}°F`} />
        </div>
        {r.load_rule ? (
          <p className="border-severe/60 border-l-2 pl-2 text-[11.5px] text-muted leading-snug">
            Load rule: {LOAD_RULE_TEXT[r.load_rule] ?? r.load_rule}.
          </p>
        ) : null}
        {!focus.pinned ? (
          <p className="label text-faint normal-case tracking-normal">Click to pin and jump the time here</p>
        ) : null}
      </div>
    </div>
  );
}
