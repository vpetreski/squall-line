import { expect, type Page, test } from "@playwright/test";
import { fakeApi, PLAN, planRequests } from "./api";

const recommended = PLAN.recommendation.route_id;
const hoursShown = (page: Page) => page.getByTestId("timebar").getAttribute("data-hours");

test.describe("planning a trip", () => {
  test("ranks three routes, explains the pick and draws the corridor", async ({ page }) => {
    const sent = await fakeApi(page);
    await page.goto("/");
    await page.getByRole("button", { name: "Chicago → Atlanta" }).click();

    await expect(page.getByTestId("recommendation")).toContainText(`Route ${recommended}`);
    for (const route of PLAN.routes) await expect(page.getByTestId(`route-${route.id}`)).toBeVisible();
    await expect(page.getByTestId(`route-${recommended}`)).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("checkpoints")).toContainText(
      `${PLAN.routes.find((r) => r.id === recommended)?.checkpoints.length} checkpoints`,
    );

    const body = planRequests(sent)[0]?.postDataJSON();
    expect(body).toMatchObject({
      origin: { label: "Chicago, IL" },
      destination: { label: "Atlanta, GA" },
      load_lb: 42000,
    });
    expect(body.departure).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/); // wall time at the origin, whose zone is known
    await expect(page).toHaveURL(/from=41\.87810%2C-87\.62980%2CChicago.*&depart=.*-0[56]%3A00/);
  });

  test("scrubs the 48 hours and switches the heatmap layer", async ({ page }) => {
    await fakeApi(page);
    await page.goto("/");
    await page.getByRole("button", { name: "Chicago → Atlanta" }).click();
    const slider = page.getByRole("slider", { name: "Hours after departure" });
    await expect(slider).toBeVisible();
    expect(await hoursShown(page)).toBe("0.00");

    await slider.focus();
    await page.keyboard.press("End");
    expect(await hoursShown(page)).toBe("48.00");
    await page.keyboard.press("ArrowLeft");
    expect(await hoursShown(page)).toBe("47.75");

    const wind = page.getByRole("button", { name: "Wind", exact: true });
    await wind.click();
    await expect(wind).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("legend")).toContainText("mph");
    await page.getByRole("button", { name: "Risk", exact: true }).click();
    await expect(page.getByTestId("legend")).toContainText("No Travel");
  });

  test("plays the clock forward and stops at the end", async ({ page }) => {
    await fakeApi(page);
    await page.goto("/");
    await page.getByRole("button", { name: "Chicago → Atlanta" }).click();
    await page.getByRole("button", { name: "Play the next 48 hours" }).click();
    await expect.poll(async () => Number(await hoursShown(page))).toBeGreaterThan(1);
    await expect.poll(async () => Number(await hoursShown(page)), { timeout: 20_000 }).toBe(48);
    await expect(page.getByRole("button", { name: "Play the next 48 hours" })).toBeVisible();
  });

  test("pins a checkpoint from the list and jumps the clock to its ETA", async ({ page }) => {
    await fakeApi(page);
    await page.goto("/");
    await page.getByRole("button", { name: "Chicago → Atlanta" }).click();
    const route = PLAN.routes.find((r) => r.id === recommended);
    const checkpoint = route?.checkpoints[8];
    if (!checkpoint) throw new Error("fixture has too few checkpoints");
    const rows = page.getByTestId("checkpoints").locator("button.grid");
    await rows.nth(8).click();
    const expected = (Date.parse(checkpoint.eta) - Date.parse(PLAN.request.departure)) / 3_600_000;
    expect(Number(await hoursShown(page))).toBeCloseTo(expected, 1);
    await expect(page.getByTestId("focus-card")).toContainText(`Mile ${Math.round(checkpoint.mile)}`, {
      ignoreCase: true,
    });
  });

  test("selects another route from its card", async ({ page }) => {
    await fakeApi(page);
    await page.goto("/");
    await page.getByRole("button", { name: "Chicago → Atlanta" }).click();
    const other = PLAN.routes.find((r) => r.id !== recommended);
    if (!other) throw new Error("fixture has one route");
    await page.getByTestId(`route-${other.id}`).click();
    await expect(page.getByTestId(`route-${other.id}`)).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("checkpoints")).toContainText(`Route ${other.id}`);
  });
});

test.describe("when things go wrong", () => {
  test("fetches the forecast from the browser when the server is out of quota", async ({ page }) => {
    const relay = {
      url: "https://api.open-meteo.com/v1/forecast",
      form: { latitude: "41.88,33.75", longitude: "-87.63,-84.39", hourly: "wind_speed_10m" },
      locations: [
        [41.88, -87.63],
        [33.75, -84.39],
      ],
    };
    const sent = await fakeApi(page, [
      { status: 503, body: { error: { code: "weather_rate_limited", message: "Out of quota.", relay } } },
      { status: 200, body: PLAN },
    ]);
    const forecast = [{ hourly: { time: [] } }, { hourly: { time: [] } }];
    let relayed = "";
    await page.route("https://api.open-meteo.com/**", (route) => {
      relayed = route.request().postData() ?? "";
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify(forecast),
      });
    });
    await page.goto("/");
    await page.getByRole("button", { name: "Chicago → Atlanta" }).click();
    await expect(page.getByTestId("recommendation")).toContainText(`Route ${recommended}`);
    expect(relayed).toBe(new URLSearchParams(relay.form).toString());
    const second = planRequests(sent)[1]?.postDataJSON();
    expect(second.weather).toEqual({ locations: relay.locations, response: forecast });
  });

  test("shows the server's message and lets the user try again", async ({ page }) => {
    await fakeApi(page, [
      { status: 422, body: { error: { code: "no_route", message: "No truck route connects these places." } } },
      { status: 200, body: PLAN },
    ]);
    await page.goto("/");
    await page.getByRole("button", { name: "Chicago → Atlanta" }).click();
    const error = page.getByTestId("error");
    await expect(error).toContainText("No truck route connects these places.");
    await error.getByRole("button").click();
    await expect(page.getByTestId("recommendation")).toBeVisible();
  });
});

test.describe("entering a trip", () => {
  test("finds places as you type and plans from the keyboard", async ({ page }) => {
    const sent = await fakeApi(page);
    await page.goto("/");
    const origin = page.getByTestId("origin");
    await origin.fill("Den");
    await expect(page.getByRole("option", { name: /Denver, CO/ })).toBeVisible();
    await origin.press("Enter");
    await expect(origin).toHaveValue("Denver, CO");
    await page.getByTestId("destination").fill("Den");
    await page.getByRole("option", { name: /Denton, TX/ }).click();
    await page.getByTestId("plan").click();
    await expect(page.getByTestId("recommendation")).toBeVisible();
    const body = planRequests(sent)[0]?.postDataJSON();
    expect(body.origin).toEqual({ lat: 39.7392, lon: -104.9903, label: "Denver, CO" });
    expect(body.destination.label).toBe("Denton, TX");
  });

  test("reopens a shared trip and plans it at the shared moment", async ({ page }) => {
    const sent = await fakeApi(page);
    const when = new Date(Date.now() + 26 * 3_600_000);
    when.setUTCMinutes(0, 0, 0);
    const iso = `${when.toISOString().slice(0, 16)}+00:00`;
    await page.goto(
      `/?from=41.87810,-87.62980,Chicago%2C+IL&to=33.74900,-84.38800,Atlanta%2C+GA&depart=${encodeURIComponent(iso)}&load=30000&every=10&hos=0`,
    );
    await expect(page.getByTestId("recommendation")).toBeVisible();
    const body = planRequests(sent)[0]?.postDataJSON();
    expect(Date.parse(body.departure)).toBe(when.getTime());
    expect(body).toMatchObject({ load_lb: 30000, interval_mi: 10, hours_of_service: false });
  });
});

test.describe("the recorded storm", () => {
  test("replays a recorded plan, says so, and never calls the planner", async ({ page }) => {
    const sent = await fakeApi(page);
    await page.goto("/");
    await page.getByRole("button", { name: "Recorded storm · 3 Nov" }).click();
    await expect(page.getByTestId("recorded")).toContainText("Recorded plan");
    await expect(page.getByTestId("recommendation")).toContainText(`Route ${recommended}`);
    await expect(page.getByTestId("timebar")).toContainText("Recorded");
    await expect(page).toHaveURL(/\?demo=storm$/);
    expect(planRequests(sent)).toHaveLength(0);
  });

  test("opens from its link, and Plan redoes the trip live from now", async ({ page }) => {
    const sent = await fakeApi(page);
    await page.goto("/?demo=storm");
    await expect(page.getByTestId("recorded")).toBeVisible();
    await page.getByTestId("plan").click();
    await expect(page.getByTestId("recorded")).toHaveCount(0);
    const body = planRequests(sent)[0]?.postDataJSON();
    expect(body.origin.label).toBe(PLAN.request.origin.label);
    expect(Date.parse(`${body.departure}Z`)).toBeGreaterThan(Date.now() - 36 * 3_600_000); // not the recorded day's
  });
});
