import type { Map as MapLibre } from "maplibre-gl";
import { describe, expect, it } from "vitest";
import { PLANS } from "../test/fixtures";
import { checkpointFeatures, OTHER_CHECKPOINTS, stackRoutes } from "./layers";

const plan = PLANS["chicago-atlanta"];
if (!plan) throw new Error("fixture missing");
const ids = plan.routes.map((r) => r.id);

/** Just enough of a map to keep its layers in drawing order, bottom first. */
function layerStack(layers: string[]) {
  const map = {
    getLayer: (id: string) => (layers.includes(id) ? { id } : undefined),
    moveLayer: (id: string, before?: string) => {
      layers.splice(layers.indexOf(id), 1);
      layers.splice(before ? layers.indexOf(before) : layers.length, 0, id);
    },
  } as unknown as Pick<MapLibre, "getLayer" | "moveLayer">;
  return { map, layers };
}

describe("checkpoints on the map", () => {
  it("include every route's, the selected route's apart", () => {
    const { selected, others } = checkpointFeatures(plan, "B");
    const routeOf = (f: (typeof selected.features)[number]) => f.properties?.route;
    expect(new Set(selected.features.map(routeOf))).toEqual(new Set(["B"]));
    expect(new Set(others.features.map(routeOf))).toEqual(new Set(ids.filter((id) => id !== "B")));
    const total = plan.routes.reduce((n, r) => n + r.checkpoints.length, 0);
    expect(selected.features.length + others.features.length).toBe(total);
    expect(selected.features[3]?.properties).toEqual({
      route: "B",
      index: 3,
      level: plan.routes.find((r) => r.id === "B")?.checkpoints[3]?.risk.level,
    });
  });

  it.each(ids)("keep route %s's line and checkpoints above the other routes' checkpoints", (selectedId) => {
    // The order the map starts with: the base map, the data layers under the place names, then the markers.
    const { map, layers } = layerStack([
      "water",
      OTHER_CHECKPOINTS,
      ...ids.flatMap((id) => [`route-${id}-casing`, `route-${id}`]),
      "place-state",
      "stops",
      "checkpoints",
      "focus",
    ]);
    stackRoutes(map, ids, "A", "place-state");
    stackRoutes(map, ids, selectedId, "place-state");
    const at = (id: string) => layers.indexOf(id);
    for (const id of ids.filter((r) => r !== selectedId)) {
      expect(at(`route-${id}`)).toBeLessThan(at(OTHER_CHECKPOINTS)); // the dimmed points show on their own lines
    }
    expect(at(OTHER_CHECKPOINTS)).toBe(at(`route-${selectedId}-casing`) - 1);
    expect(at(`route-${selectedId}-casing`)).toBeLessThan(at(`route-${selectedId}`));
    expect(at(`route-${selectedId}`)).toBeLessThan(at("place-state"));
    expect(at("place-state")).toBeLessThan(at("checkpoints")); // the selected route's points stay on top
    expect(layers).toHaveLength(ids.length * 2 + 6);
  });
});
