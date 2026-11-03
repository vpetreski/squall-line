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

  it("turns a fraction of the length on the ground into a fraction of the length on the map", () => {
    // Due north from the equator to 60° N. Web Mercator stretches the north, so halfway on the ground (30° N) is
    // well short of halfway on the map.
    const north = new Line(Array.from({ length: 61 }, (_, lat): [number, number] => [lat, -90]));
    const y = (lat: number) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
    expect(north.at(0.5)[0]).toBeCloseTo(30, 6);
    expect(north.progress(0.5)).toBeCloseTo(y(30) / y(60), 6); // 0.417
    expect(north.progress(0.25)).toBeCloseTo(y(15) / y(60), 6);
    expect(north.progress(0)).toBe(0);
    expect(north.progress(1)).toBeCloseTo(1, 12);
    // Along the equator the two agree.
    const east = new Line([
      [0, 0],
      [0, 1],
      [0, 3],
    ]);
    expect(east.progress(0.5)).toBeCloseTo(0.5, 9);
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
