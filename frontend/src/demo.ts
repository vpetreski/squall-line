/**
 * A recorded plan for the days the live forecast is calm: Chicago to Atlanta as planned on 3 November 2026,
 * from the same recording the tests replay. It is loaded only when asked for and always shown as recorded.
 */
import { type Plan, Plan as PlanSchema } from "./api/schema";

export async function recordedStorm(): Promise<Plan> {
  const data = await import("./fixtures/chicago-atlanta.json");
  return PlanSchema.parse(data.default);
}

/** When a plan was made: its departure less the lead time of the forecast at the first checkpoint. */
export function plannedAt(plan: Plan): number {
  const first = plan.routes[0]?.checkpoints[0];
  return Date.parse(plan.request.departure) - (first?.lead_h ?? 0) * 3_600_000;
}

/** Put the recording on screen, with its trip in the form so "Plan" redoes it live, from now. */
export async function openRecordedStorm(): Promise<void> {
  const { useStore } = await import("./state/store");
  const plan = await recordedStorm();
  const { origin, destination, load_lb, interval_mi, hours_of_service, time_zone } = plan.request;
  const state = useStore.getState();
  state.setInput({
    origin: { lat: origin.lat, lon: origin.lon, label: origin.label },
    destination: { lat: destination.lat, lon: destination.lon, label: destination.label },
    load_lb,
    interval_mi: interval_mi === 10 || interval_mi === 50 ? interval_mi : 25,
    hours_of_service,
  });
  state.setZones({ origin: time_zone, destination: plan.routes[0]?.checkpoints.at(-1)?.time_zone ?? null });
  state.showRecorded(plan, plannedAt(plan));
}
