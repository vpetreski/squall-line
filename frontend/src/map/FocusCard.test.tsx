import { screen } from "@testing-library/react";
import type { Map as MapLibre } from "maplibre-gl";
import { describe, expect, it } from "vitest";
import type { Checkpoint } from "../api/schema";
import { useStore } from "../state/store";
import { planWithWeather } from "../test/plans";
import { renderWithRules } from "../test/render";
import { FocusCard } from "./FocusCard";

const map = {
  on: () => undefined,
  off: () => undefined,
  project: () => ({ x: 200, y: 200 }),
  getContainer: () => ({ clientWidth: 1200, clientHeight: 800 }),
} as unknown as MapLibre;

function card(weather: Partial<Checkpoint["weather"]>) {
  const { plan } = planWithWeather(weather);
  useStore.setState({ plan, focus: { routeId: plan.recommendation.route_id, index: 0, pinned: true } });
  renderWithRules(<FocusCard map={map} plan={plan} />);
  return screen.getByTestId("focus-card");
}

describe("focus card", () => {
  it.each([
    [{ rain_in_hr: 1.004 }, "1.004 in/hr", "No Travel"],
    [{ rain_in_hr: 1.0 }, "1.000 in/hr", "Severe"],
    [{ snow_in_hr: 0.4996 }, "0.500 in/hr", "Moderate"],
    [{ wind_mph: 24.6 }, "24.6 mph", "Low"],
  ] as const)("shows %o at the precision it is classified at", (weather, value, level) => {
    const shown = card(weather);
    expect(screen.getByText(value)).toBeInTheDocument();
    expect(shown).toHaveTextContent(level);
  });
});
