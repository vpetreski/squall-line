import { describe, expect, it } from "vitest";
import { isStopped, mileAt } from "./timeline";

// Drive 100 mi in 2 h, stop 30 min, drive 50 mi in 1 h.
const timeline: [number, number][] = [
  [0, 0],
  [7200, 100],
  [9000, 100],
  [12600, 150],
];

describe("timeline", () => {
  it("interpolates the mile between its pairs and clamps outside them", () => {
    expect(mileAt(timeline, -10)).toBe(0);
    expect(mileAt(timeline, 3600)).toBe(50);
    expect(mileAt(timeline, 8000)).toBe(100);
    expect(mileAt(timeline, 10800)).toBe(125);
    expect(mileAt(timeline, 99999)).toBe(150);
    expect(mileAt([], 10)).toBe(0);
  });

  it("knows when the truck stands still", () => {
    expect(isStopped(timeline, 8000)).toBe(true);
    expect(isStopped(timeline, 3600)).toBe(false);
    expect(isStopped(timeline, 12000)).toBe(false);
  });
});
