const EARTH_RADIUS_MI = 3958.7613;
const rad = (deg: number) => (deg * Math.PI) / 180;

export function haversineMi(a: [number, number], b: [number, number]): number {
  const dLat = rad(b[0] - a[0]);
  const dLon = rad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_MI * Math.asin(Math.sqrt(Math.min(1, h)));
}

/** A polyline with its cumulative length, for placing things by distance along it. */
export class Line {
  readonly cumulative: Float64Array;

  constructor(readonly points: [number, number][]) {
    this.cumulative = new Float64Array(points.length);
    for (let i = 1; i < points.length; i++) {
      const prev = points[i - 1] as [number, number];
      const here = points[i] as [number, number];
      this.cumulative[i] = (this.cumulative[i - 1] ?? 0) + haversineMi(prev, here);
    }
  }

  get length(): number {
    return this.cumulative[this.cumulative.length - 1] ?? 0;
  }

  /** [lat, lon] at a fraction of the way along the line (0 = start, 1 = end). */
  at(fraction: number): [number, number] {
    const n = this.points.length;
    if (n === 0) return [0, 0];
    const target = Math.min(Math.max(fraction, 0), 1) * this.length;
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if ((this.cumulative[mid] ?? 0) <= target) lo = mid;
      else hi = mid;
    }
    const a = this.points[lo] as [number, number];
    const b = this.points[hi] as [number, number];
    const span = (this.cumulative[hi] ?? 0) - (this.cumulative[lo] ?? 0);
    const t = span > 0 ? (target - (this.cumulative[lo] ?? 0)) / span : 0;
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
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
