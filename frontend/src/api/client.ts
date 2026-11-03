import { ApiError, GeocodeOut, Plan, type PlanInput, type Relay, Rules, type Suggestion } from "./schema";

export class RequestFailed extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly fields: Record<string, string> = {},
  ) {
    super(message);
    this.name = "RequestFailed";
  }
}

/** What the planner is doing, for the progress line. */
export type Stage = "planning" | "relaying" | "assessing";

async function failure(response: Response): Promise<RequestFailed> {
  const body = ApiError.safeParse(await response.json().catch(() => null));
  if (body.success) {
    const { code, message, fields } = body.data.error;
    return new RequestFailed(code, message, response.status, fields ?? {});
  }
  return new RequestFailed("http_error", `The server answered ${response.status}.`, response.status);
}

export async function getRules(signal?: AbortSignal): Promise<Rules> {
  const response = await fetch("/api/rules", { signal });
  if (!response.ok) throw await failure(response);
  return Rules.parse(await response.json());
}

export async function geocode(query: string, signal?: AbortSignal): Promise<Suggestion[]> {
  const response = await fetch(`/api/geocode?q=${encodeURIComponent(query)}&limit=6`, { signal });
  if (!response.ok) throw await failure(response);
  return GeocodeOut.parse(await response.json()).results;
}

/** Warm the API function so the first plan does not pay for a cold start. */
export function ping(): void {
  fetch("/api/health", { cache: "no-store" }).catch(() => undefined);
}

const RELAY_ROUNDS = 2;
const RELAY_TIMEOUT_MS = 30_000;
const FORECAST_DOWN = "The forecast could not be fetched, by the server or by this browser. Try again in a minute.";

/** A signal that aborts when either does: `AbortSignal.any`, or the same by hand where it is missing (Safari 17.3). */
function either(a: AbortSignal, b: AbortSignal): AbortSignal {
  if (typeof AbortSignal.any === "function") return AbortSignal.any([a, b]);
  const both = new AbortController();
  for (const one of [a, b]) {
    if (one.aborted) {
      both.abort(one.reason);
      break;
    }
    one.addEventListener("abort", () => both.abort(one.reason), { once: true });
  }
  return both.signal;
}

/** The relayed Open-Meteo query, sent from the browser: its answer, or a RequestFailed a person can read. */
async function relayed(relay: Relay, signal: AbortSignal | undefined): Promise<unknown> {
  const timeout = AbortSignal.timeout(RELAY_TIMEOUT_MS);
  let forecast: Response;
  try {
    forecast = await fetch(relay.url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(relay.form),
      signal: signal ? either(signal, timeout) : timeout,
    });
    if (forecast.ok) return await forecast.json();
  } catch (exc) {
    if (signal?.aborted) throw exc; // the plan was cancelled, which is not a failure to report
    throw new RequestFailed(timeout.aborted ? "weather_timeout" : "weather_unavailable", FORECAST_DOWN, 0);
  }
  throw new RequestFailed("weather_unavailable", FORECAST_DOWN, forecast.status);
}

/**
 * Plan a trip. When the server cannot fetch the forecast itself (Open-Meteo's free quota is per IP address, and a
 * busy server address runs out), it answers with the exact Open-Meteo query; the browser sends it from its own
 * address and asks again with the answer attached. The server validates that answer and uses it for this request
 * only.
 */
export async function planTrip(input: PlanInput, onStage: (stage: Stage) => void, signal?: AbortSignal): Promise<Plan> {
  onStage("planning");
  let body: Record<string, unknown> = { ...input };
  for (let round = 0; ; round++) {
    const response = await fetch("/api/plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    if (response.ok) return Plan.parse(await response.json());
    const parsed = ApiError.safeParse(
      await response
        .clone()
        .json()
        .catch(() => null),
    );
    const error = parsed.success ? parsed.data.error : null;
    if (!error?.relay) throw await failure(response);
    // The server's message tells an API client how to relay; after the last round a person only needs to know
    // that it did not work.
    if (round >= RELAY_ROUNDS) throw new RequestFailed(error.code, FORECAST_DOWN, response.status);
    onStage("relaying");
    const forecast = await relayed(error.relay, signal);
    onStage("assessing");
    body = { ...input, weather: { locations: error.relay.locations, response: forecast } };
  }
}
