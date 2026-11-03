import { browserZone, zoneName } from "../lib/time";
import { useStore } from "../state/store";
import { type Place, PlaceInput } from "./PlaceInput";

const TARE_LB = 35_000;

type Sample = { name: string; origin: Required<Place>; destination: Required<Place> };

const CHICAGO = { lat: 41.8781, lon: -87.6298, label: "Chicago, IL", time_zone: "America/Chicago" };
const SAMPLES: Sample[] = [
  {
    name: "Chicago → Atlanta",
    origin: CHICAGO,
    destination: { lat: 33.749, lon: -84.388, label: "Atlanta, GA", time_zone: "America/New_York" },
  },
  {
    name: "Denver → Salt Lake City",
    origin: { lat: 39.7392, lon: -104.9903, label: "Denver, CO", time_zone: "America/Denver" },
    destination: { lat: 40.7608, lon: -111.891, label: "Salt Lake City, UT", time_zone: "America/Denver" },
  },
  {
    name: "Dallas → Nashville",
    origin: { lat: 32.7767, lon: -96.797, label: "Dallas, TX", time_zone: "America/Chicago" },
    destination: { lat: 36.1627, lon: -86.7816, label: "Nashville, TN", time_zone: "America/Chicago" },
  },
  {
    name: "Sacramento → Reno",
    origin: { lat: 38.5816, lon: -121.4944, label: "Sacramento, CA", time_zone: "America/Los_Angeles" },
    destination: { lat: 39.5296, lon: -119.8138, label: "Reno, NV", time_zone: "America/Los_Angeles" },
  },
];

const ready = (p: { lat: number; lon: number }) => Number.isFinite(p.lat) && Number.isFinite(p.lon);

export function TripForm() {
  const input = useStore((s) => s.input);
  const zones = useStore((s) => s.zones);
  const status = useStore((s) => s.status);
  const setInput = useStore((s) => s.setInput);
  const setZones = useStore((s) => s.setZones);
  const setDeparture = useStore((s) => s.setDeparture);
  const run = useStore((s) => s.run);
  const busy = status === "planning" || status === "relaying" || status === "assessing";
  const canPlan = ready(input.origin) && ready(input.destination) && !busy;
  const zone = zones.origin ?? browserZone();

  const setOrigin = (place: Place) => {
    setInput({ origin: { lat: place.lat, lon: place.lon, label: place.label } });
    setZones({ origin: place.time_zone ?? null });
  };
  const setDestination = (place: Place) => {
    setInput({ destination: { lat: place.lat, lon: place.lon, label: place.label } });
    setZones({ destination: place.time_zone ?? null });
  };
  const swap = () => {
    setInput({ origin: input.destination, destination: input.origin });
    setZones({ origin: zones.destination, destination: zones.origin });
  };

  const plan = () => {
    if (!canPlan) return;
    void run();
  };

  const sample = (s: Sample) => {
    setInput({
      origin: { lat: s.origin.lat, lon: s.origin.lon, label: s.origin.label },
      destination: { lat: s.destination.lat, lon: s.destination.lon, label: s.destination.label },
    });
    setZones({ origin: s.origin.time_zone, destination: s.destination.time_zone });
    void run();
  };

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        plan();
      }}
      aria-label="Trip"
    >
      <div className="grid grid-cols-[1fr_auto] gap-x-2">
        <div className="min-w-0 space-y-3">
          <PlaceInput
            label="Origin"
            testId="origin"
            value={input.origin}
            onChange={setOrigin}
            placeholder="City, address or lat, lon"
          />
          <PlaceInput
            label="Destination"
            testId="destination"
            value={input.destination}
            onChange={setDestination}
            placeholder="City, address or lat, lon"
          />
        </div>
        <button
          type="button"
          className="mt-[22px] w-8 border border-line-strong text-[15px] text-muted hover:border-muted hover:text-ink"
          title="Swap origin and destination"
          aria-label="Swap origin and destination"
          onClick={swap}
        >
          ⇅
        </button>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label htmlFor="departure" className="label mb-1.5 flex justify-between">
            <span>Departure</span>
            <span className="num normal-case tracking-normal text-faint" title={zone}>
              {zoneName(Date.now(), zone)}
              {zones.origin ? "" : " · your clock"}
            </span>
          </label>
          <input
            id="departure"
            data-testid="departure"
            type="datetime-local"
            className="field [color-scheme:dark]"
            value={input.departure}
            onChange={(event) => setDeparture(event.target.value, true)}
            required
          />
        </div>
        <div>
          <label htmlFor="load" className="label mb-1.5 flex justify-between">
            <span>Load</span>
            <span className="num normal-case tracking-normal text-faint">lb</span>
          </label>
          <input
            id="load"
            data-testid="load"
            type="number"
            inputMode="numeric"
            className="field"
            min={0}
            max={80_000}
            step={500}
            value={Number.isFinite(input.load_lb) ? input.load_lb : ""}
            onChange={(event) => setInput({ load_lb: Math.min(Math.max(Number(event.target.value) || 0, 0), 80_000) })}
          />
        </div>
      </div>

      <div>
        <input
          type="range"
          aria-label="Load in pounds"
          className="w-full accent-[#ededf0]"
          min={0}
          max={60_000}
          step={500}
          value={Math.min(input.load_lb, 60_000)}
          onChange={(event) => setInput({ load_lb: Number(event.target.value) })}
        />
        <div className="label mt-1 flex justify-between normal-case tracking-normal">
          <span>
            Gross {(TARE_LB + input.load_lb).toLocaleString("en-US")} lb
            {TARE_LB + input.load_lb > 80_000 ? " · over the 80,000 lb federal limit (permit load)" : ""}
          </span>
          <span className={input.load_lb > 40_000 ? "text-high" : input.load_lb > 30_000 ? "text-moderate" : ""}>
            {input.load_lb > 40_000 ? "both load rules" : input.load_lb > 30_000 ? "one load rule" : "no load rule"}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-[1fr_auto] items-end gap-3">
        <fieldset className="m-0 min-w-0 border-0 p-0">
          <legend className="label mb-1.5 block p-0">Checkpoint every</legend>
          <div className="seg">
            {([10, 25, 50] as const).map((mi) => (
              <button
                key={mi}
                type="button"
                aria-pressed={input.interval_mi === mi}
                onClick={() => setInput({ interval_mi: mi })}
              >
                {mi} mi
              </button>
            ))}
          </div>
        </fieldset>
        <label className="flex cursor-pointer select-none items-center gap-2 border border-line-strong px-3 py-2">
          <input
            type="checkbox"
            className="size-3.5 accent-[#ededf0]"
            checked={input.hours_of_service}
            onChange={(event) => setInput({ hours_of_service: event.target.checked })}
          />
          <span className="num text-[12px] text-ink">HOS breaks</span>
        </label>
      </div>

      <button type="submit" className="btn-primary w-full text-[15px]" disabled={!canPlan} data-testid="plan">
        {busy ? "Planning…" : "Plan three routes"}
      </button>

      <div>
        <span className="label mb-2 block">Or try</span>
        <div className="flex flex-wrap gap-1.5">
          {SAMPLES.map((s) => (
            <button key={s.name} type="button" className="btn-ghost" onClick={() => sample(s)} disabled={busy}>
              {s.name}
            </button>
          ))}
        </div>
      </div>
    </form>
  );
}
