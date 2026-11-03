import { create } from "zustand";
import { planTrip, RequestFailed, type Stage } from "../api/client";
import type { Plan, PlanInput } from "../api/schema";
import type { LayerName } from "../lib/heatmap";
import { browserZone, nextQuarterHour, withOffset } from "../lib/time";

export type Status = "idle" | Stage | "done" | "error";

export type Focus = { routeId: string; index: number; pinned: boolean };

/** The IANA time zone of each end, once known (from the place search or from a plan). */
export type Zones = { origin: string | null; destination: string | null };

type State = {
  input: PlanInput;
  zones: Zones;
  /** The departure was typed or came from a shared link, so a new origin keeps it instead of resetting it. */
  departureSet: boolean;
  /** When the plan on screen was made, if it is a recording rather than a live plan. */
  recordedAt: number | null;
  plan: Plan | null;
  status: Status;
  startedAt: number;
  error: RequestFailed | null;
  selectedId: string | null;
  hoveredId: string | null;
  hours: number;
  layer: LayerName;
  playing: boolean;
  focus: Focus | null;
  setInput: (patch: Partial<PlanInput>) => void;
  setZones: (patch: Partial<Zones>) => void;
  setDeparture: (local: string, explicit: boolean) => void;
  run: () => Promise<void>;
  showRecorded: (plan: Plan, recordedAt: number) => void;
  select: (id: string | null) => void;
  hover: (id: string | null) => void;
  setHours: (hours: number) => void;
  setLayer: (layer: LayerName) => void;
  setPlaying: (playing: boolean) => void;
  setFocus: (focus: Focus | null) => void;
};

let inflight: AbortController | null = null;

export const useStore = create<State>((set, get) => ({
  input: {
    origin: { lat: Number.NaN, lon: Number.NaN, label: "" },
    destination: { lat: Number.NaN, lon: Number.NaN, label: "" },
    departure: nextQuarterHour(browserZone()),
    load_lb: 42_000,
    interval_mi: 25,
    hours_of_service: true,
  },
  zones: { origin: null, destination: null },
  departureSet: false,
  recordedAt: null,
  plan: null,
  status: "idle",
  startedAt: 0,
  error: null,
  selectedId: null,
  hoveredId: null,
  hours: 0,
  layer: "risk",
  playing: false,
  focus: null,

  setInput: (patch) => set((s) => ({ input: { ...s.input, ...patch } })),
  setZones: (patch) =>
    set((s) => {
      const zones = { ...s.zones, ...patch };
      const moved = zones.origin !== s.zones.origin && zones.origin !== null;
      return moved && !s.departureSet
        ? { zones, input: { ...s.input, departure: nextQuarterHour(zones.origin ?? browserZone()) } }
        : { zones };
    }),
  setDeparture: (local, explicit) =>
    set((s) => ({ input: { ...s.input, departure: local }, departureSet: s.departureSet || explicit })),

  run: async () => {
    inflight?.abort();
    const controller = new AbortController();
    inflight = controller;
    set({ status: "planning", startedAt: performance.now(), error: null, playing: false });
    try {
      const { zones, departureSet } = get();
      const zone = zones.origin ?? browserZone();
      // A departure nobody chose means "now": the next quarter hour, so a plan made earlier can be run again.
      if (!departureSet) set((s) => ({ input: { ...s.input, departure: nextQuarterHour(zone) } }));
      const { input } = get();
      // Until the origin's zone is known, the form shows (and the user means) the browser's own clock.
      const departure = zones.origin ? input.departure : withOffset(input.departure, zone);
      const plan = await planTrip({ ...input, departure }, (stage) => set({ status: stage }), controller.signal);
      if (inflight !== controller) return;
      const last = plan.routes[0]?.checkpoints.at(-1);
      set((s) => ({
        plan,
        recordedAt: null,
        status: "done",
        input: { ...s.input, departure: plan.request.departure.slice(0, 16) },
        zones: { origin: plan.request.time_zone, destination: last?.time_zone ?? s.zones.destination },
        selectedId: plan.recommendation.route_id,
        hoveredId: null,
        hours: 0,
        focus: null,
      }));
    } catch (exc) {
      if (controller.signal.aborted) return;
      const error =
        exc instanceof RequestFailed
          ? exc
          : new RequestFailed("network", "The planner could not be reached. Check the connection and try again.", 0);
      set({ status: "error", error });
    } finally {
      if (inflight === controller) inflight = null;
    }
  },

  showRecorded: (plan, recordedAt) => {
    inflight?.abort();
    inflight = null;
    set({
      plan,
      recordedAt,
      status: "done",
      error: null,
      playing: false,
      selectedId: plan.recommendation.route_id,
      hoveredId: null,
      hours: 0,
      focus: null,
    });
  },

  select: (id) => set({ selectedId: id, focus: null }),
  hover: (id) => set({ hoveredId: id }),
  setHours: (hours) => set({ hours }),
  setLayer: (layer) => set({ layer }),
  setPlaying: (playing) => set({ playing }),
  setFocus: (focus) => set({ focus }),
}));
