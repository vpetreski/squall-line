import { useEffect } from "react";
import { useRules } from "../api/hooks";
import type { Plan, Rules } from "../api/schema";
import { type LayerName, RAMPS, RISK_RGBA, rampColor } from "../lib/heatmap";
import { LEVEL_LABEL } from "../lib/risk";
import { dayTime, zoneName } from "../lib/time";
import { useStore } from "../state/store";

const LAYERS: { id: LayerName; name: string }[] = [
  { id: "risk", name: "Risk" },
  { id: "wind", name: "Wind" },
  { id: "rain", name: "Rain" },
  { id: "snow", name: "Snow" },
];
const HOURS_PER_SECOND = 4;

const rgba = ([r, g, b, a]: [number, number, number, number]) =>
  `rgba(${Math.round(r)},${Math.round(g)},${Math.round(b)},${Math.max(a, 0.08).toFixed(2)})`;

function Legend({ layer, rules }: { layer: LayerName; rules: Rules | undefined }) {
  if (layer === "risk") {
    return (
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1" data-testid="legend">
        {RISK_RGBA.map((c, i) => {
          const level = (["low", "moderate", "high", "severe", "no_travel"] as const)[i];
          return level ? (
            <span key={level} className="flex items-center gap-1 whitespace-nowrap">
              <span
                className="inline-block size-2.5 border border-line-strong"
                style={{ background: i === 0 ? "transparent" : rgba(c) }}
              />
              <span className="label normal-case tracking-normal">{LEVEL_LABEL[level]}</span>
            </span>
          ) : null;
        })}
      </div>
    );
  }
  const scale = rules?.[layer];
  const stops = RAMPS[layer];
  const max = (stops[stops.length - 1] as [number, unknown])[0];
  const ticks = scale ? [scale.moderate, scale.high, scale.severe, scale.no_travel] : [];
  const gradient = Array.from({ length: 24 }, (_, i) => rgba(rampColor(stops, (max * i) / 23)));
  return (
    <div className="w-full sm:w-[260px]" data-testid="legend">
      <div className="h-2.5 w-full" style={{ background: `linear-gradient(90deg, ${gradient.join(",")})` }} />
      <div className="relative mt-1 h-3">
        {ticks.map((t) => (
          <span
            key={t}
            className="num absolute -translate-x-1/2 text-[9.5px] text-muted"
            style={{ left: `${(t / max) * 100}%` }}
          >
            {t}
          </span>
        ))}
        <span className="num absolute right-0 text-[9.5px] text-faint">{scale?.unit}</span>
      </div>
    </div>
  );
}

/** The corridor's 48 hours: scrub or play, pick the layer. Trucks on the map move with the clock. */
export function TimeBar({ plan }: { plan: Plan }) {
  const hours = useStore((s) => s.hours);
  const layer = useStore((s) => s.layer);
  const playing = useStore((s) => s.playing);
  const setHours = useStore((s) => s.setHours);
  const setLayer = useStore((s) => s.setLayer);
  const setPlaying = useStore((s) => s.setPlaying);
  const rules = useRules();
  const last = plan.corridor.frames - 1;

  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    let before = performance.now();
    const tick = (now: number) => {
      const state = useStore.getState();
      const next = state.hours + ((now - before) / 1000) * HOURS_PER_SECOND;
      before = now;
      if (next >= last) {
        state.setHours(last);
        state.setPlaying(false);
        return;
      }
      state.setHours(next);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, last]);

  const zone = plan.request.time_zone;
  const at = Date.parse(plan.corridor.start) + hours * 3_600_000;
  const lead = Math.round((at - Date.now()) / 3_600_000);

  return (
    <div
      className="pointer-events-auto select-none border-line-strong border-y bg-panel/95 backdrop-blur-sm lg:border"
      data-testid="timebar"
      data-hours={hours.toFixed(2)}
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-line border-b px-3 py-2">
        <div className="flex items-baseline gap-2">
          <span className="display text-[18px]">+{hours.toFixed(1)} h</span>
          <span className="num text-[12.5px] text-ink">
            {dayTime(at, zone)} <span className="text-muted">{zoneName(at, zone)}</span>
          </span>
          <span className="label normal-case tracking-normal">forecast {lead >= 0 ? `+${lead}` : lead} h</span>
        </div>
        <div className="flex w-full flex-wrap items-center gap-x-3 gap-y-2 sm:ml-auto sm:w-auto sm:flex-nowrap">
          <Legend layer={layer} rules={rules.data} />
          <fieldset className="seg w-full sm:w-[232px] sm:shrink-0">
            <legend className="sr-only">Heatmap layer</legend>
            {LAYERS.map((l) => (
              <button key={l.id} type="button" aria-pressed={layer === l.id} onClick={() => setLayer(l.id)}>
                {l.name}
              </button>
            ))}
          </fieldset>
        </div>
      </div>
      <div className="flex items-center gap-3 px-3 py-1.5">
        <button
          type="button"
          className="btn-ghost w-[88px] shrink-0 whitespace-nowrap text-ink"
          aria-label={playing ? "Pause" : "Play the next 48 hours"}
          onClick={() => {
            if (!playing && hours >= last) setHours(0);
            setPlaying(!playing);
          }}
        >
          {playing ? "❚❚ Pause" : "▶ Play"}
        </button>
        <span className="num shrink-0 text-[10.5px] text-faint">DEP</span>
        <input
          type="range"
          className="time"
          min={0}
          max={last}
          step={0.25}
          value={hours}
          aria-label="Hours after departure"
          aria-valuetext={`${hours.toFixed(1)} hours after departure, ${dayTime(at, zone)}`}
          onChange={(event) => {
            setPlaying(false);
            setHours(Number(event.target.value));
          }}
        />
        <span className="num shrink-0 whitespace-nowrap text-[10.5px] text-faint">+{last} H</span>
      </div>
    </div>
  );
}
