import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { planTrip } from "../api/client";
import { browserZone, nextQuarterHour, withOffset } from "../lib/time";
import { PLANS } from "../test/fixtures";
import { useStore } from "./store";

vi.mock("../api/client", async (original) => ({
  ...(await original<typeof import("../api/client")>()),
  planTrip: vi.fn(),
}));

const plan = PLANS["sacramento-reno"];
const initial = useStore.getState();

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-04T13:20:00Z"));
  useStore.setState(initial, true);
  useStore.setState({ input: { ...initial.input, departure: nextQuarterHour(browserZone()) } });
  vi.mocked(planTrip).mockReset();
  if (plan) vi.mocked(planTrip).mockResolvedValue(plan);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("departure time", () => {
  it("moves an untouched departure to the next quarter hour at a newly chosen origin", () => {
    useStore.getState().setZones({ origin: "America/Los_Angeles" });
    expect(useStore.getState().input.departure).toBe("2026-11-04T05:30");
  });

  it("keeps a departure the user typed when the origin changes", () => {
    useStore.getState().setDeparture("2026-11-05T09:00", true);
    useStore.getState().setZones({ origin: "America/Los_Angeles" });
    expect(useStore.getState().input.departure).toBe("2026-11-05T09:00");
  });

  it("sends the browser's own offset while the origin's zone is unknown", async () => {
    useStore.getState().setDeparture("2026-11-05T09:00", true);
    await useStore.getState().run();
    const sent = vi.mocked(planTrip).mock.calls[0]?.[0];
    expect(sent?.departure).toBe(withOffset("2026-11-05T09:00", browserZone()));
  });

  it("sends wall time at the origin once its zone is known, and takes the plan's zone and time after", async () => {
    useStore.getState().setZones({ origin: "America/Los_Angeles" });
    await useStore.getState().run();
    expect(vi.mocked(planTrip).mock.calls[0]?.[0].departure).toBe("2026-11-04T05:30");
    const state = useStore.getState();
    expect(state.status).toBe("done");
    expect(state.zones.origin).toBe(plan?.request.time_zone);
    expect(state.input.departure).toBe(plan?.request.departure.slice(0, 16));
    expect(state.selectedId).toBe(plan?.recommendation.route_id);
  });

  it("re-plans an untouched departure from now, not from an hour that has passed", async () => {
    useStore.getState().setZones({ origin: "UTC" });
    vi.setSystemTime(new Date("2026-11-04T15:02:00Z"));
    await useStore.getState().run();
    expect(vi.mocked(planTrip).mock.calls[0]?.[0].departure).toBe("2026-11-04T15:15");
  });
});

describe("planning", () => {
  it("keeps only the latest of two overlapping runs", async () => {
    let resolveFirst: (value: typeof plan) => void = () => undefined;
    vi.mocked(planTrip)
      .mockImplementationOnce(() => new Promise((resolve) => (resolveFirst = resolve as typeof resolveFirst)))
      .mockResolvedValueOnce(PLANS["chicago-atlanta"] as NonNullable<typeof plan>);
    const first = useStore.getState().run();
    await useStore.getState().run();
    resolveFirst(plan);
    await first;
    expect(useStore.getState().plan).toBe(PLANS["chicago-atlanta"]);
  });

  it("reports a failure as an error the panel can show", async () => {
    vi.mocked(planTrip).mockRejectedValue(new TypeError("Failed to fetch"));
    await useStore.getState().run();
    expect(useStore.getState().status).toBe("error");
    expect(useStore.getState().error?.code).toBe("network");
  });
});
