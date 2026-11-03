import { screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Checkpoint, Rules } from "../api/schema";
import { useStore } from "../state/store";
import { RULES } from "../test/fixtures";
import { planWithWeather } from "../test/plans";
import { renderWithRules } from "../test/render";
import { CheckpointList } from "./CheckpointList";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The first checkpoint row's wind, rain, snow and risk cells. */
function firstRow(weather: Partial<Checkpoint["weather"]>, rules: Rules | null = RULES) {
  const { plan } = planWithWeather(weather);
  useStore.setState({ plan, selectedId: plan.recommendation.route_id, focus: null, hours: 0 });
  renderWithRules(<CheckpointList plan={plan} />, rules);
  const row = screen.getByTestId("checkpoints").querySelector("button[class*='grid']");
  const [, , wind, rain, snow, risk] = [...(row?.children ?? [])].map((cell) => cell.textContent);
  return { wind, rain, snow, risk };
}

describe("checkpoint list numbers", () => {
  it.each([
    [{ rain_in_hr: 1.004 }, "rain", "1.004", "NO TRAVEL"],
    [{ rain_in_hr: 1.0 }, "rain", "1.000", "SEV"],
    [{ snow_in_hr: 3.001 }, "snow", "3.001", "NO TRAVEL"],
    [{ wind_mph: 24.6, gust_mph: 31 }, "wind", "24.6/31", "LOW"],
    [{ wind_mph: 25, gust_mph: 31 }, "wind", "25.0/31", "MOD"],
  ] as const)("show %o at the precision it is classified at", (weather, cell, text, level) => {
    const row = firstRow(weather);
    expect(row[cell]).toBe(text);
    expect(row.risk).toBe(level);
  });

  it("take the precision from the rules", () => {
    const rules = { ...RULES, wind: { ...RULES.wind, decimals: 2 }, rain: { ...RULES.rain, decimals: 4 } };
    const row = firstRow({ wind_mph: 24.6, gust_mph: 31, rain_in_hr: 0.25 }, rules);
    expect(row.wind).toBe("24.60/31");
    expect(row.rain).toBe("0.2500");
  });

  it("use the server's precision before the rules arrive", () => {
    vi.stubGlobal("fetch", () => new Promise(() => undefined));
    const row = firstRow({ wind_mph: 24.6, gust_mph: 31, rain_in_hr: 1.004 }, null);
    expect(row.wind).toBe("24.6/31");
    expect(row.rain).toBe("1.004");
  });
});
