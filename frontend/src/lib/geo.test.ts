import { describe, expect, it } from "vitest";
import { bounds, haversineMi, Line } from "./geo";
import { decodePolyline } from "./polyline";

describe("polyline", () => {
  it("decodes Google's reference example at precision 5", () => {
    expect(decodePolyline("_p~iF~ps|U_ulLnnqC_mqNvxq`@", 5)).toEqual([
      [38.5, -120.2],
      [40.7, -120.95],
      [43.252, -126.453],
    ]);
  });
});

describe("geometry", () => {
  it("measures great-circle miles", () => {
    expect(haversineMi([41.8781, -87.6298], [33.749, -84.388])).toBeCloseTo(588.754, 2); // the same haversine, computed independently
    expect(haversineMi([0, 0], [0, 1])).toBeCloseTo(69.09, 1);
  });

  it("places points by distance along a line", () => {
    const line = new Line([
      [0, 0],
      [0, 1],
      [0, 3],
    ]);
    expect(line.length).toBeCloseTo(3 * 69.09, 0);
    expect(line.at(0)).toEqual([0, 0]);
    expect(line.at(1)).toEqual([0, 3]);
    expect(line.at(0.5)[1]).toBeCloseTo(1.5, 6);
    expect(line.at(2)).toEqual([0, 3]);
  });

  it("boxes points as [[west, south], [east, north]]", () => {
    expect(
      bounds([
        [33.7, -84.4],
        [41.9, -87.6],
      ]),
    ).toEqual([
      [-87.6, 33.7],
      [-84.4, 41.9],
    ]);
  });
});
