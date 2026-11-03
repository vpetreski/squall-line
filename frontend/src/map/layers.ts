import type { FeatureCollection } from "geojson";
import type { Map as MapLibre } from "maplibre-gl";
import type { Plan } from "../api/schema";

/** The layer of the routes that are not selected: their checkpoints, smaller and dimmed. */
export const OTHER_CHECKPOINTS = "checkpoints-other";

/** Every route's checkpoints: the selected route's, which take hover and clicks, and the other routes'. */
export function checkpointFeatures(
  plan: Plan,
  selectedId: string | null,
): { selected: FeatureCollection; others: FeatureCollection } {
  const features = (selected: boolean): FeatureCollection => ({
    type: "FeatureCollection",
    features: plan.routes
      .filter((route) => (route.id === selectedId) === selected)
      .flatMap((route) =>
        route.checkpoints.map((c, index) => ({
          type: "Feature" as const,
          properties: { route: route.id, index, level: c.risk.level },
          geometry: { type: "Point" as const, coordinates: [c.lon, c.lat] },
        })),
      ),
  });
  return { selected: features(true), others: features(false) };
}

/**
 * Bottom to top, under the place names (`labelsAbove`): the other routes' lines, their checkpoints, then the
 * selected route's line. Where routes share a road the selected line covers the others' checkpoints, and its own
 * checkpoints are drawn above everything.
 */
export function stackRoutes(
  map: Pick<MapLibre, "getLayer" | "moveLayer">,
  routeIds: string[],
  selectedId: string | null,
  labelsAbove: string,
): void {
  const order = [...routeIds].sort((a, b) => Number(a === selectedId) - Number(b === selectedId));
  for (const id of order) {
    if (!map.getLayer(`route-${id}`)) continue;
    map.moveLayer(`route-${id}-casing`, labelsAbove);
    map.moveLayer(`route-${id}`, labelsAbove);
  }
  const casing = `route-${selectedId}-casing`;
  if (map.getLayer(OTHER_CHECKPOINTS)) map.moveLayer(OTHER_CHECKPOINTS, map.getLayer(casing) ? casing : labelsAbove);
}
