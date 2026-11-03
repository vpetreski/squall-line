import { expect, test } from "@playwright/test";
import { fakeApi, PLAN } from "./api";

test("nothing overflows the window sideways", async ({ page }) => {
  await fakeApi(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Chicago → Atlanta" }).click();
  await expect(page.getByTestId("recommendation")).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});

test("a phone reads form, then map and clock, then the answer", async ({ page, isMobile }) => {
  test.skip(!isMobile, "phone layout");
  await fakeApi(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Chicago → Atlanta" }).click();
  await expect(page.getByTestId("recommendation")).toBeVisible();
  const top = async (testId: string) => (await page.getByTestId(testId).boundingBox())?.y ?? Number.NaN;
  const form = await top("plan");
  const map = await top("map");
  const clock = await top("timebar");
  const answer = await top("recommendation");
  expect(form).toBeLessThan(map);
  expect(map).toBeLessThan(clock);
  expect(clock).toBeLessThan(answer);
});

test("the checkpoint table fits its width and lines up with its header", async ({ page }) => {
  // The widest row there can be: wind at 0.1 mph with its gusts, rain and snow at 0.001 in/hr, No Travel, and a
  // four-digit mile.
  const plan = structuredClone(PLAN);
  const route = plan.routes.find((r) => r.id === plan.recommendation.route_id);
  const wide = route?.checkpoints[1];
  const last = route?.checkpoints.at(-1);
  if (!wide || !last) throw new Error("fixture has too few checkpoints");
  wide.weather = { ...wide.weather, wind_mph: 54.9, gust_mph: 71.2, rain_in_hr: 1.004, snow_in_hr: 3.001 };
  wide.risk = { ...wide.risk, level: "no_travel" };
  last.mile = 2999.6;
  await fakeApi(page, [{ status: 200, body: plan }]);
  await page.goto("/");
  await page.getByRole("button", { name: "Chicago → Atlanta" }).click();
  await expect(page.getByTestId("recommendation")).toBeVisible();
  const misfits = await page.getByTestId("checkpoints").evaluate((list) => {
    const header = list.querySelector("div.grid");
    if (!header) throw new Error("no table header");
    const columns = [...header.children].map((cell) => cell.getBoundingClientRect());
    const out: string[] = [];
    for (const row of list.querySelectorAll("button.grid")) {
      const inner = row.getBoundingClientRect().right - Number.parseFloat(getComputedStyle(row).paddingRight);
      [...row.children].forEach((cell, i) => {
        const box = cell.getBoundingClientRect();
        const range = document.createRange();
        range.selectNodeContents(cell);
        const text = range.getBoundingClientRect();
        const column = columns[i];
        if (!column || Math.abs(box.left - column.left) > 1 || Math.abs(box.right - column.right) > 1)
          out.push(`"${cell.textContent}" is not under its header`);
        if (text.left < box.left - 0.5 || text.right > box.right + 0.5)
          out.push(`"${cell.textContent}" overflows its cell`);
        if (box.right > inner + 0.5) out.push(`"${cell.textContent}" runs past the row`);
      });
    }
    return out;
  });
  expect(misfits).toEqual([]);
});

test("the heatmap keeps up with the slider", async ({ page, isMobile }) => {
  test.skip(isMobile, "measured once, on the desktop layout");
  await fakeApi(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Chicago → Atlanta" }).click();
  await expect(page.getByTestId("timebar")).toBeVisible();
  // Drag the clock through all 48 hours, a step per animation frame, and watch for main-thread stalls.
  const worst = await page.evaluate(async () => {
    const slider = document.querySelector<HTMLInputElement>("input[type=range].time");
    if (!slider) throw new Error("no slider");
    const stalls: number[] = [];
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) stalls.push(entry.duration);
    });
    observer.observe({ type: "longtask", buffered: false });
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    for (let step = 0; step <= 192; step++) {
      setter?.call(slider, String(step / 4));
      slider.dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    observer.disconnect();
    return Math.max(0, ...stalls);
  });
  expect(worst).toBeLessThan(200);
});
