import { afterEach, describe, expect, it, vi } from "vitest";
import sacramentoReno from "../fixtures/sacramento-reno.json";
import { planTrip, RequestFailed, type Stage } from "./client";
import type { PlanInput } from "./schema";

const input: PlanInput = {
  origin: { lat: 38.5816, lon: -121.4944, label: "Sacramento, CA" },
  destination: { lat: 39.5296, lon: -119.8138, label: "Reno, NV" },
  departure: "2026-11-04T06:00",
  load_lb: 20_000,
  interval_mi: 10,
  hours_of_service: true,
};

const relay = {
  url: "https://api.open-meteo.com/v1/forecast",
  form: { latitude: "38.58,39.53", longitude: "-121.49,-119.81", hourly: "wind_speed_10m,rain" },
  locations: [
    [38.58, -121.49],
    [39.53, -119.81],
  ],
};

const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
// The server's own message, written for API clients.
const limited = () =>
  reply(503, {
    error: {
      code: "weather_rate_limited",
      message:
        "The forecast service's free quota for this server is used up for the moment. Send `relay.form` to `relay.url` and repeat the plan with the answer.",
      relay,
    },
  });
const PLAIN = "The forecast could not be fetched, by the server or by this browser. Try again in a minute.";

type Call = { url: string; init: RequestInit };

function serve(answers: ((call: Call) => Response | Promise<Response>)[]): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const call = { url, init };
      calls.push(call);
      const answer = answers[calls.length - 1];
      if (!answer) throw new Error(`unexpected request ${init.method} ${url}`);
      return answer(call);
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("planTrip", () => {
  it("returns the plan the server sends", async () => {
    const calls = serve([() => reply(200, sacramentoReno)]);
    const stages: Stage[] = [];
    const plan = await planTrip(input, (s) => stages.push(s));
    expect(plan.routes.map((r) => r.id).sort()).toEqual(["A", "B", "C"]);
    expect(stages).toEqual(["planning"]);
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual(input);
  });

  it("fetches the forecast from the browser when the server is out of quota, then asks again with it", async () => {
    const forecast = [{ hourly: { time: [] } }, { hourly: { time: [] } }];
    const calls = serve([limited, () => reply(200, forecast), () => reply(200, sacramentoReno)]);
    const stages: Stage[] = [];
    await planTrip(input, (s) => stages.push(s));
    expect(stages).toEqual(["planning", "relaying", "assessing"]);
    expect(calls[1]?.url).toBe(relay.url);
    expect(String(calls[1]?.init.body)).toBe(new URLSearchParams(relay.form).toString());
    expect(JSON.parse(String(calls[2]?.init.body))).toEqual({
      ...input,
      weather: { locations: relay.locations, response: forecast },
    });
  });

  it("stops relaying after two rounds and says so plainly", async () => {
    const forecast = () => reply(200, []);
    serve([limited, forecast, limited, forecast, limited]);
    await expect(planTrip(input, () => undefined)).rejects.toMatchObject({
      code: "weather_rate_limited",
      status: 503,
      message: PLAIN,
    });
  });

  it("says so plainly when the forecast service itself fails", async () => {
    serve([limited, () => reply(500, {})]);
    await expect(planTrip(input, () => undefined)).rejects.toMatchObject({
      code: "weather_unavailable",
      message: PLAIN,
    });
  });

  it("says so plainly when the browser cannot reach the forecast service", async () => {
    serve([
      limited,
      () => {
        throw new TypeError("Failed to fetch");
      },
    ]);
    await expect(planTrip(input, () => undefined)).rejects.toMatchObject({
      code: "weather_unavailable",
      message: PLAIN,
    });
  });

  it("gives up on the relayed query after 30 seconds", async () => {
    const clock = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(clock.signal);
    const sent = new Promise<void>((resolve) => {
      serve([
        limited,
        ({ init }) => {
          resolve();
          return new Promise<Response>((_, reject) => {
            init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
          });
        },
      ]);
    });
    const plan = planTrip(input, () => undefined);
    await sent;
    expect(timeout).toHaveBeenCalledWith(30_000);
    clock.abort(new DOMException("The operation timed out.", "TimeoutError"));
    await expect(plan).rejects.toMatchObject({ code: "weather_timeout", message: PLAIN });
    timeout.mockRestore();
  });

  it("stays quiet when the plan is cancelled during the relay", async () => {
    const cancel = new AbortController();
    serve([
      limited,
      ({ init }) =>
        new Promise<Response>((_, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
          cancel.abort();
        }),
    ]);
    const error = await planTrip(input, () => undefined, cancel.signal).catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(RequestFailed);
    expect(error).toMatchObject({ name: "AbortError" });
  });

  it("turns the error envelope into a RequestFailed with the field messages", async () => {
    serve([
      () =>
        reply(422, {
          error: { code: "invalid_request", message: "Check the trip.", fields: { load_lb: "At most 80000." } },
        }),
    ]);
    const error = await planTrip(input, () => undefined).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RequestFailed);
    expect(error).toMatchObject({ code: "invalid_request", status: 422, fields: { load_lb: "At most 80000." } });
  });

  it("names the status when the answer is not the API's envelope", async () => {
    serve([() => new Response("<html>Bad gateway</html>", { status: 502 })]);
    await expect(planTrip(input, () => undefined)).rejects.toMatchObject({ code: "http_error", status: 502 });
  });
});
