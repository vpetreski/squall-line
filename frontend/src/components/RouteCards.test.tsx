import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { useStore } from "../state/store";
import { PLANS } from "../test/fixtures";
import { CheckpointList } from "./CheckpointList";
import { Recommendation, RouteCards, reason } from "./RouteCards";

const plan = PLANS["chicago-atlanta"];
if (!plan) throw new Error("fixture missing");

beforeEach(() => {
  useStore.setState({ plan, selectedId: plan.recommendation.route_id, focus: null, hours: 0 });
});

describe("reason", () => {
  it.each([
    [{ route_id: "B", key: "no_travel_miles", best: 0, other: 15 }, "15 mi of No Travel, against 0."],
    [{ route_id: "B", key: "severe_miles", best: 2.5, other: 7.5 }, "7.5 mi of Severe, against 2.5."],
    [{ route_id: "B", key: "high_miles", best: 0, other: 25 }, "25 mi of High, against 0."],
    [{ route_id: "B", key: "average_risk", best: 0.03, other: 0.11 }, "Average risk 0.11, against 0.03."],
    [{ route_id: "B", key: "trip_time_s", best: 3600, other: 7200 }, "Same risk, 1 h slower."],
    [{ route_id: "B", key: null, best: null, other: null }, "Ties the recommended route on every measure."],
  ] as const)("explains %o", (comparison, text) => {
    expect(reason(comparison)).toBe(text);
  });
});

describe("route cards", () => {
  it("show every route in rank order with the recommended one first", () => {
    render(<RouteCards plan={plan} />);
    const ids = plan.routes.map((r) => r.id);
    expect(ids).toHaveLength(3);
    const cards = ids.map((id) => screen.getByTestId(`route-${id}`));
    expect(cards[0]).toHaveTextContent("Recommended");
    expect(cards[0]).toHaveAttribute("aria-pressed", "true");
    expect(cards[1]).toHaveTextContent("Rank 2");
    expect(cards[2]).toHaveTextContent("Rank 3");
  });

  it("select a route on click", async () => {
    render(<RouteCards plan={plan} />);
    const other = plan.routes[2];
    if (!other) throw new Error("fixture has fewer than three routes");
    await userEvent.click(screen.getByTestId(`route-${other.id}`));
    expect(useStore.getState().selectedId).toBe(other.id);
  });

  it("state why the runner-up lost", () => {
    render(<Recommendation plan={plan} />);
    const runnerUp = plan.recommendation.comparisons[0];
    expect(screen.getByTestId("recommendation")).toHaveTextContent(`Next best is route ${runnerUp?.route_id}`);
  });
});

describe("checkpoint list", () => {
  it("lists every checkpoint of the selected route and its stops in mile order", () => {
    render(<CheckpointList plan={plan} />);
    const route = plan.routes.find((r) => r.id === plan.recommendation.route_id);
    const list = screen.getByTestId("checkpoints");
    expect(list.querySelectorAll("button[class*='grid']")).toHaveLength(route?.checkpoints.length ?? -1);
    expect(list).toHaveTextContent(`${route?.checkpoints.length} checkpoints`);
  });

  it("pins a checkpoint and moves the clock to its arrival when clicked", async () => {
    render(<CheckpointList plan={plan} />);
    const rows = screen.getByTestId("checkpoints").querySelectorAll<HTMLButtonElement>("button[class*='grid']");
    const row = rows[5];
    if (!row) throw new Error("too few checkpoints");
    await userEvent.click(row);
    const { focus, hours } = useStore.getState();
    expect(focus).toMatchObject({ index: 5, pinned: true });
    const route = plan.routes.find((r) => r.id === plan.recommendation.route_id);
    const eta = Date.parse(route?.checkpoints[5]?.eta ?? "");
    expect(hours).toBeCloseTo((eta - Date.parse(plan.request.departure)) / 3_600_000, 6);
  });
});
