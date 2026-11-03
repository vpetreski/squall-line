const EARTH_RADIUS_MI = 3958.7613;
const rad = (deg: number) => (deg * Math.PI) / 180;

export function haversineMi(a: [number, number], b: [number, number]): number {
  const dLat = rad(b[0] - a[0]);
  const dLon = rad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_MI * Math.asin(Math.sqrt(Math.min(1, h)));
}

/** Web Mercator coordinates (in units of the Earth's radius) of [lat, lon]. */
const mercator = ([lat, lon]: [number, number]): [number, number] => [
  rad(lon),
  Math.log(Math.tan(Math.PI / 4 + rad(lat) / 2)),
];

/** A polyline with its cumulative length, for placing things by distance along it. */
export class Line {
  readonly cumulative: Float64Array;
  /** Cumulative length in Web Mercator, the map's projection. */
  readonly projected: Float64Array;

  constructor(readonly points: [number, number][]) {
    this.cumulative = new Float64Array(points.length);
    this.projected = new Float64Array(points.length);
    for (let i = 1; i < points.length; i++) {
      const prev = points[i - 1] as [number, number];
      const here = points[i] as [number, number];
      this.cumulative[i] = (this.cumulative[i - 1] ?? 0) + haversineMi(prev, here);
      const [x0, y0] = mercator(prev);
      const [x1, y1] = mercator(here);
      this.projected[i] = (this.projected[i - 1] ?? 0) + Math.hypot(x1 - x0, y1 - y0);
    }
  }

  get length(): number {
    return this.cumulative[this.cumulative.length - 1] ?? 0;
  }

  /** The segment that holds a fraction of the way along the line, and how far into it, from 0 to 1. */
  private locate(fraction: number): { lo: number; hi: number; t: number } {
    const target = Math.min(Math.max(fraction, 0), 1) * this.length;
    let lo = 0;
    let hi = this.points.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if ((this.cumulative[mid] ?? 0) <= target) lo = mid;
      else hi = mid;
    }
    const span = (this.cumulative[hi] ?? 0) - (this.cumulative[lo] ?? 0);
    return { lo, hi, t: span > 0 ? (target - (this.cumulative[lo] ?? 0)) / span : 0 };
  }

  /** [lat, lon] at a fraction of the way along the line (0 = start, 1 = end). */
  at(fraction: number): [number, number] {
    if (this.points.length === 0) return [0, 0];
    const { lo, hi, t } = this.locate(fraction);
    const a = this.points[lo] as [number, number];
    const b = this.points[hi] as [number, number];
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  }

  /**
   * The fraction of the line's length on the map (in Web Mercator) at a fraction of its length on the ground.
   * MapLibre's `line-progress` runs along the projected line, which stretches towards the poles, so anything placed
   * on a route by miles needs this to land on the right mile.
   */
  progress(fraction: number): number {
    const total = this.projected[this.projected.length - 1] ?? 0;
    if (total <= 0) return Math.min(Math.max(fraction, 0), 1);
    const { lo } = this.locate(fraction);
    const [xa, ya] = mercator(this.points[lo] as [number, number]);
    const [x, y] = mercator(this.at(fraction));
    return Math.min(((this.projected[lo] ?? 0) + Math.hypot(x - xa, y - ya)) / total, 1);
  }
}

/** [[west, south], [east, north]] around every point. */
export function bounds(points: [number, number][]): [[number, number], [number, number]] {
  let west = 180;
  let east = -180;
  let south = 90;
  let north = -90;
  for (const [lat, lon] of points) {
    west = Math.min(west, lon);
    east = Math.max(east, lon);
    south = Math.min(south, lat);
    north = Math.max(north, lat);
  }
  return [
    [west, south],
    [east, north],
  ];
}
