import { expect, test } from "@playwright/test";
import { fakeApi } from "./api";

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
