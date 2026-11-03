"""HTTP API. Interactive documentation: /api/docs."""

from __future__ import annotations

import logging

from django.http import HttpRequest, HttpResponse
from ninja import NinjaAPI
from ninja.errors import HttpError, ValidationError

from . import geocoding, service, weather
from .http import UpstreamError
from .risk import rules_table
from .schemas import ErrorOut, GeocodeOut, PlanIn, PlanOut

log = logging.getLogger(__name__)

api = NinjaAPI(
    title="Squall Line API",
    version="1.0.0",
    description="Weather-aware truck routing: three routes, weather at the truck's arrival time, risk rules.",
)


def error(request: HttpRequest, status: int, code: str, message: str, fields: dict | None = None) -> HttpResponse:
    body: dict = {"code": code, "message": message}
    if fields:
        body["fields"] = fields
    return api.create_response(request, {"error": body}, status=status)


@api.exception_handler(ValidationError)
def invalid(request: HttpRequest, exc: ValidationError) -> HttpResponse:
    fields = {}
    for e in exc.errors:
        loc = [str(p) for p in e.get("loc", []) if p not in ("body", "payload", "query")]
        fields[".".join(loc) or "request"] = e.get("msg", "invalid")
    return error(request, 422, "invalid_request", "Some fields are missing or invalid.", fields)


@api.exception_handler(HttpError)
def http_error(request: HttpRequest, exc: HttpError) -> HttpResponse:
    if exc.status_code == 400 and str(exc).startswith("Cannot parse request body"):
        return error(request, 400, "invalid_json", "The request body is not valid JSON.")
    return error(request, exc.status_code, f"http_{exc.status_code}", str(exc))


@api.exception_handler(service.PlanError)
def plan_error(request: HttpRequest, exc: service.PlanError) -> HttpResponse:
    return error(request, exc.status, exc.code, exc.message)


@api.exception_handler(weather.WeatherRelay)
def weather_relay(request: HttpRequest, exc: weather.WeatherRelay) -> HttpResponse:
    log.warning("weather relayed to the client (%s): %s", exc.code, exc)
    reasons = {
        "weather_rate_limited": "The forecast service's free quota for this server is used up for the moment.",
        "weather_timeout": "The forecast service did not answer in time.",
        "weather_unavailable": "The forecast service is not answering this server.",
    }
    message = f"{reasons.get(exc.code, str(exc))} Send `relay.form` to `relay.url` and repeat the plan with the answer."
    body = {"code": exc.code, "message": message, "relay": exc.query}
    return api.create_response(request, {"error": body}, status=503)


@api.exception_handler(UpstreamError)
def upstream(request: HttpRequest, exc: UpstreamError) -> HttpResponse:
    log.warning("upstream %s failed: %s", exc.service, exc)
    messages = {
        "routing": "The routing service is not answering. Try again in a minute.",
        "weather": "The weather service is busy or not answering. Try again in a minute.",
        "geocoding": "Place search is not answering. Try again, or enter coordinates.",
    }
    return error(request, 503, f"{exc.service}_unavailable", messages.get(exc.service, str(exc)))


@api.get("/health", summary="Liveness, and the routing engines in use")
def health(request: HttpRequest) -> dict:
    from .routing import providers

    return {"status": "ok", "routing": [p.name for p in providers()]}


@api.get("/rules", summary="The risk thresholds and load rules")
def rules(request: HttpRequest) -> dict:
    return rules_table()


@api.get("/geocode", response={200: GeocodeOut, 503: ErrorOut}, summary="Type-ahead search for US places")
def geocode(request: HttpRequest, q: str, limit: int = 6) -> dict:
    return {"results": geocoding.suggest(q[:120], max(1, min(limit, 10)))}


@api.post("/plan", response={200: PlanOut, 422: ErrorOut, 503: ErrorOut}, summary="Plan a trip")
def plan(request: HttpRequest, payload: PlanIn) -> dict:
    return service.plan(payload)
