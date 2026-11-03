/** The trip in the address bar, so a plan can be shared and reopened. */
import type { PlanInput } from "../api/schema";

/** A trip read back from a link. The departure is an instant (epoch ms), since the reader may be in another zone. */
export type SharedTrip = Partial<Omit<PlanInput, "departure">> & { departure?: number };

const place = (p: { lat: number; lon: number; label: string }) => `${p.lat.toFixed(5)},${p.lon.toFixed(5)},${p.label}`;

function readPlace(value: string | null): PlanInput["origin"] | null {
  if (!value) return null;
  const [lat, lon, ...label] = value.split(",");
  const la = Number(lat);
  const lo = Number(lon);
  if (!lat?.trim() || !lon?.trim() || !Number.isFinite(la) || !Number.isFinite(lo)) return null;
  if (Math.abs(la) > 90 || Math.abs(lo) > 180) return null;
  return { lat: la, lon: lo, label: label.join(",").trim() || `${la.toFixed(4)}, ${lo.toFixed(4)}` };
}

/** `departure` is the plan's own departure, an ISO time with the origin's offset. */
export function writeTrip(input: PlanInput, departure: string): string {
  const q = new URLSearchParams({
    from: place(input.origin),
    to: place(input.destination),
    depart: departure,
    load: String(input.load_lb),
    every: String(input.interval_mi),
    hos: input.hours_of_service ? "1" : "0",
  });
  return `?${q.toString()}`;
}

export function readTrip(search: string): SharedTrip {
  const q = new URLSearchParams(search);
  const out: SharedTrip = {};
  const origin = readPlace(q.get("from"));
  const destination = readPlace(q.get("to"));
  if (origin) out.origin = origin;
  if (destination) out.destination = destination;
  const depart = q.get("depart");
  // With an offset this is an exact instant; a bare wall time is read on this browser's clock.
  if (depart && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(depart)) {
    const at = Date.parse(depart);
    if (Number.isFinite(at)) out.departure = at;
  }
  const load = Number(q.get("load"));
  if (q.get("load")?.trim() && Number.isFinite(load) && load >= 0 && load <= 80_000) out.load_lb = load;
  const every = Number(q.get("every"));
  if (every === 10 || every === 25 || every === 50) out.interval_mi = every;
  if (q.has("hos")) out.hours_of_service = q.get("hos") !== "0";
  return out;
}
