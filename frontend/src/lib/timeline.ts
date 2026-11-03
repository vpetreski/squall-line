/**
 * Where the truck is at a moment of the trip. The API gives (seconds after departure, mile) pairs that are exact at
 * the pairs and linear between them; a stop shows as two pairs at the same mile.
 */
export function mileAt(timeline: [number, number][], elapsedS: number): number {
  const n = timeline.length;
  if (n === 0) return 0;
  const first = timeline[0] as [number, number];
  const last = timeline[n - 1] as [number, number];
  if (elapsedS <= first[0]) return first[1];
  if (elapsedS >= last[0]) return last[1];
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if ((timeline[mid] as [number, number])[0] <= elapsedS) lo = mid;
    else hi = mid;
  }
  const [t0, m0] = timeline[lo] as [number, number];
  const [t1, m1] = timeline[hi] as [number, number];
  return t1 > t0 ? m0 + ((m1 - m0) * (elapsedS - t0)) / (t1 - t0) : m1;
}

/** Whether the truck is stopped (break or rest) at this moment. */
export function isStopped(timeline: [number, number][], elapsedS: number): boolean {
  for (let i = 1; i < timeline.length; i++) {
    const [t0, m0] = timeline[i - 1] as [number, number];
    const [t1, m1] = timeline[i] as [number, number];
    if (elapsedS >= t0 && elapsedS < t1) return m1 === m0 && t1 > t0;
  }
  return false;
}
