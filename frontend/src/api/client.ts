import { ApiError, GeocodeOut, Plan, type PlanInput, Rules, type Suggestion } from "./schema";

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
    const relay = parsed.success ? parsed.data.error.relay : null;
    if (!relay || round >= RELAY_ROUNDS) throw await failure(response);
    onStage("relaying");
    const forecast = await fetch(relay.url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(relay.form),
      signal,
    });
    if (!forecast.ok) {
      throw new RequestFailed(
        "weather_unavailable",
        "The forecast service is not answering. Try again in a minute.",
        forecast.status,
      );
    }
    onStage("assessing");
    body = { ...input, weather: { locations: relay.locations, response: await forecast.json() } };
  }
}
