import { useEffect, useRef } from "react";
import { ping } from "./api/client";
import type { Plan } from "./api/schema";
import { CheckpointList } from "./components/CheckpointList";
import { Recommendation, RouteCards } from "./components/RouteCards";
import { RulesPanel } from "./components/RulesPanel";
import { Status } from "./components/Status";
import { TimeBar } from "./components/TimeBar";
import { TripForm } from "./components/TripForm";
import { openRecordedStorm } from "./demo";
import { browserZone, dayTime, wallTime } from "./lib/time";
import { readTrip, writeTrip } from "./lib/url";
import { MapView } from "./map/MapView";
import { useStore } from "./state/store";

const REPO = "https://github.com/vpetreski/squall-line";
const PROVIDER: Record<string, string> = { tomtom: "TomTom", valhalla: "Valhalla", osrm: "OSRM" };
const DEFAULT_ATTRIBUTION = [
  "Weather data by Open-Meteo.com (CC BY 4.0)",
  "Map data © OpenStreetMap contributors, OpenFreeMap",
];

function Header() {
  return (
    <header className="border-line border-b px-5 pt-5 pb-4">
      <div className="flex items-end justify-between gap-3">
        <h1 className="display text-[34px]">
          Squall
          <br />
          Line
        </h1>
        <svg viewBox="0 0 64 36" className="mb-1 h-9 w-16" aria-hidden="true">
          <path
            d="M2 26 14 8l9 15 9-19 9 16 9-9 12 10"
            fill="none"
            stroke="#ededf0"
            strokeWidth="3.2"
            strokeLinejoin="miter"
          />
          <path d="M2 33h60" stroke="#ef4444" strokeWidth="2.4" />
        </svg>
      </div>
      <p className="label mt-3">Weather-aware truck routing · 48-hour corridor</p>
    </header>
  );
}

function Intro() {
  return (
    <section
      className="space-y-2.5 border border-line px-4 py-3.5 text-[13px] text-muted leading-relaxed"
      data-testid="intro"
    >
      <p className="text-ink">
        Three truck routes between two US places, the forecast at the moment the truck passes every checkpoint, and a
        recommendation by miles of risk.
      </p>
      <p>
        Pick an origin and a destination, or one of the trips above. After planning, hover a checkpoint for its weather,
        click it to jump the clock there, and scrub the bar under the map through the next 48 hours.
      </p>
    </section>
  );
}

/** Says so when the plan on screen is the recording, not today's forecast. */
function Recorded() {
  const recordedAt = useStore((s) => s.recordedAt);
  if (!recordedAt) return null;
  return (
    <p
      className="border border-moderate border-dashed px-3 py-2.5 text-[12.5px] text-moderate leading-relaxed"
      data-testid="recorded"
    >
      Recorded plan: the forecast as it stood on {dayTime(recordedAt, "UTC")} UTC, not live weather. Press Plan for
      today's.
    </p>
  );
}

function Footer({ plan }: { plan: Plan | null }) {
  const t = plan?.meta.timings_ms;
  return (
    <footer className="space-y-2 border-line border-t pt-4 text-[11px] text-faint leading-relaxed">
      {plan && t ? (
        <p className="num">
          {PROVIDER[plan.meta.routing_provider] ?? plan.meta.routing_provider} routing
          {t.routing !== undefined ? ` ${Math.round(t.routing)} ms` : ""}
          {t.weather !== undefined ? ` · weather ${Math.round(t.weather)} ms` : ""} · {plan.meta.weather_locations}{" "}
          forecast points
          {plan.meta.weather_supplied > 0 ? " (fetched by this browser)" : ""}
          {plan.meta.cached_routes ? " · routes cached" : ""}
        </p>
      ) : null}
      <p>
        {(plan?.meta.attribution ?? DEFAULT_ATTRIBUTION).map((line, i) => (
          <span key={line}>
            {i > 0 ? " · " : ""}
            {line.includes("Open-Meteo") ? (
              <a className="underline hover:text-ink" href="https://open-meteo.com/" target="_blank" rel="noreferrer">
                {line}
              </a>
            ) : (
              line
            )}
          </span>
        ))}
      </p>
      <p className="flex gap-3">
        <a className="underline hover:text-ink" href={REPO} target="_blank" rel="noreferrer">
          Source code
        </a>
        <a className="underline hover:text-ink" href="/api/docs" target="_blank" rel="noreferrer">
          API reference
        </a>
      </p>
    </footer>
  );
}

export function App() {
  const plan = useStore((s) => s.plan);
  const status = useStore((s) => s.status);
  const results = useRef<HTMLDivElement>(null);
  const map = useRef<HTMLElement>(null);

  useEffect(() => {
    ping();
    if (new URLSearchParams(window.location.search).get("demo") === "storm") {
      void openRecordedStorm();
      return;
    }
    const { departure, ...trip } = readTrip(window.location.search);
    if (!trip.origin || !trip.destination) return;
    const state = useStore.getState();
    state.setInput(trip);
    // A shared departure that has already passed falls back to "now".
    if (departure !== undefined && departure > Date.now() + 60_000) {
      state.setDeparture(wallTime(departure, browserZone()), true);
    }
    void state.run();
  }, []);

  useEffect(() => {
    if (status !== "done" || !plan) return;
    const { input, recordedAt } = useStore.getState();
    window.history.replaceState(null, "", recordedAt ? "?demo=storm" : writeTrip(input, plan.request.departure));
    // Bring the answer into view: on a wide screen the side panel scrolls to the recommendation, on a phone the
    // page scrolls to the map, with the cards right under it.
    const wide = window.matchMedia("(min-width: 1024px)").matches;
    const behavior = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
    (wide ? results.current : map.current)?.scrollIntoView({ behavior, block: "start" });
  }, [status, plan]);

  // One DOM for both layouts. On a wide screen the side panel is a scrolling column beside the map. On a phone
  // the panel dissolves (display: contents) and its parts take turns with the map: form, map, then the answer.
  return (
    <div className="flex min-h-full flex-col overflow-x-clip lg:h-full lg:flex-row">
      <aside className="scroll-thin contents lg:relative lg:z-10 lg:flex lg:h-full lg:w-[452px] lg:shrink-0 lg:flex-col lg:overflow-y-auto lg:border-line lg:border-r lg:bg-bg">
        <div className="order-1">
          <Header />
        </div>
        <div className="order-2 space-y-5 px-5 pt-5 pb-6 lg:pb-0">
          <TripForm />
          <Status />
        </div>
        <div className="order-4 space-y-5 px-5 pt-5 pb-6">
          {plan ? (
            <div ref={results} className="scroll-mt-5 space-y-5">
              <Recorded />
              <Recommendation plan={plan} />
              <RouteCards plan={plan} />
              <CheckpointList plan={plan} />
            </div>
          ) : (
            <Intro />
          )}
          <RulesPanel />
          <Footer plan={plan} />
        </div>
      </aside>
      <main ref={map} className="relative order-3 flex flex-col lg:order-none lg:h-full lg:flex-1">
        <div className="relative h-[60vh] min-h-[320px] border-line border-y lg:h-full lg:min-h-0 lg:flex-1 lg:border-0">
          <MapView />
        </div>
        {/* Under the map on a phone, floating over its foot on a wide screen. */}
        {plan ? (
          <div className="z-10 lg:pointer-events-none lg:absolute lg:inset-x-4 lg:bottom-4">
            <TimeBar plan={plan} />
          </div>
        ) : null}
      </main>
    </div>
  );
}
