/** A stand-in for the Django API and the tile server, answering from the same fixtures as the unit tests. */
import type { Page, Request, Route } from "@playwright/test";
import chicagoAtlanta from "../src/test/fixtures/chicago-atlanta.json" with { type: "json" };
import rules from "../src/test/fixtures/rules.json" with { type: "json" };

export const PLAN = chicagoAtlanta;
export type Answer = { status: number; body: unknown };

const json = (route: Route, { status, body }: Answer) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

export const SUGGESTIONS = [
  { label: "Denver, CO", detail: "Colorado", lat: 39.7392, lon: -104.9903, kind: "city", time_zone: "America/Denver" },
  { label: "Denton, TX", detail: "Texas", lat: 33.2148, lon: -97.1331, kind: "city", time_zone: "America/Chicago" },
];

/**
 * Install the fake API. `plans` answers successive POST /api/plan calls in order (the last one repeats); every
 * request the page sends to the planner is recorded in the returned list.
 */
export async function fakeApi(page: Page, plans: Answer[] = [{ status: 200, body: PLAN }]): Promise<Request[]> {
  const sent: Request[] = [];
  let n = 0;
  await page.route("https://tiles.openfreemap.org/**", (route) =>
    route.request().url().endsWith("/planet")
      ? json(route, {
          status: 200,
          body: {
            tilejson: "3.0.0",
            tiles: ["https://tiles.openfreemap.org/planet/{z}/{x}/{y}.pbf"],
            minzoom: 0,
            maxzoom: 14,
            vector_layers: [],
          },
        })
      : route.fulfill({ status: 204 }),
  );
  await page.route("**/api/**", (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    sent.push(request);
    if (path === "/api/health") return json(route, { status: 200, body: { status: "ok", routing: ["tomtom"] } });
    if (path === "/api/rules") return json(route, { status: 200, body: rules });
    if (path === "/api/geocode") return json(route, { status: 200, body: { results: SUGGESTIONS } });
    if (path === "/api/plan") return json(route, plans[Math.min(n++, plans.length - 1)] as Answer);
    return json(route, { status: 404, body: { error: { code: "not_found", message: path } } });
  });
  return sent;
}

export const planRequests = (sent: Request[]) => sent.filter((r) => new URL(r.url()).pathname === "/api/plan");
