"""Request and response shapes of the API (they also generate the OpenAPI document at /api/docs)."""

from __future__ import annotations

from typing import Any, Literal

from ninja import Field, Schema

Level = Literal["low", "moderate", "high", "severe", "no_travel"]


class PointIn(Schema):
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)
    label: str = Field(default="", max_length=200)


class WeatherIn(Schema):
    """A forecast the client fetched from Open-Meteo itself, for the locations a `weather_*` error relayed."""

    locations: list[tuple[float, float]] = Field(max_length=1000)
    response: list[dict[str, Any]] | dict[str, Any] = Field(description="Open-Meteo's answer, unchanged.")


class PlanIn(Schema):
    origin: PointIn
    destination: PointIn
    departure: str = Field(
        description="Local time at the origin (`2026-11-04T08:00`) or an ISO 8601 time with an offset.",
        examples=["2026-11-04T08:00"],
    )
    load_lb: float = Field(ge=0, le=80_000, description="Weight of the cargo, in pounds.")
    interval_mi: Literal[10, 25, 50] = Field(default=25, description="Miles between weather checkpoints.")
    hours_of_service: bool = Field(default=True, description="Add the federal 30-minute breaks and 10-hour rests.")
    weather: WeatherIn | None = Field(default=None, description="Only to answer a relayed weather query.")


class Suggestion(Schema):
    label: str
    detail: str
    lat: float
    lon: float
    kind: str
    time_zone: str


class GeocodeOut(Schema):
    results: list[Suggestion]


class Weather(Schema):
    wind_mph: float
    gust_mph: float
    rain_in_hr: float
    snow_in_hr: float
    temp_f: float
    code: int


class Assessment(Schema):
    level: Level
    wind: Level
    rain: Level
    snow: Level
    load_rule: str | None
    causes: list[str]


class Checkpoint(Schema):
    mile: float
    lat: float
    lon: float
    eta: str
    drive_s: float
    represents_mi: float
    lead_h: float
    time_zone: str
    weather: Weather
    risk: Assessment


class Stop(Schema):
    kind: Literal["break", "rest"]
    mile: float
    lat: float
    lon: float
    start: str
    end: str


class Hazard(Schema):
    level: Level
    from_mile: float
    to_mile: float
    from_eta: str
    to_eta: str
    causes: list[str]


class Miles(Schema):
    low: float
    moderate: float
    high: float
    severe: float
    no_travel: float


class RouteOut(Schema):
    id: str
    name: str
    rank: int
    recommended: bool
    provider: str
    distance_mi: float
    drive_s: float
    trip_s: float
    traffic_delay_s: float
    departure: str
    arrival: str
    geometry: str = Field(description="Encoded polyline, precision 6.")
    miles: Miles
    average_risk: float
    worst: Level
    checkpoints: list[Checkpoint]
    stops: list[Stop]
    hazards: list[Hazard]
    timeline: list[tuple[float, float]] = Field(description="(seconds after departure, mile) pairs.")


class ComparisonOut(Schema):
    route_id: str
    key: str | None
    best: float | None
    other: float | None


class Recommendation(Schema):
    route_id: str
    no_safe_route: bool
    comparisons: list[ComparisonOut]


class Corridor(Schema):
    bounds: list[float] = Field(description="[west, south, east, north] of the lattice, in degrees.")
    cols: int
    rows: int
    cells: list[int] = Field(description="Row-major indices of the lattice cells inside the corridor.")
    half_width_km: float
    start: str
    step_s: int
    frames: int
    risk: list[list[int]]
    wind_mph: list[list[float]]
    rain_in_hr: list[list[float]]
    snow_in_hr: list[list[float]]


class RequestEcho(Schema):
    origin: PointIn
    destination: PointIn
    departure: str
    time_zone: str
    load_lb: float
    gross_lb: float
    interval_mi: int
    hours_of_service: bool


class Meta(Schema):
    routing_provider: str
    weather_locations: int
    weather_downloaded: int
    weather_cached: int
    weather_supplied: int
    weather_snapped: int
    weather_grid_deg: tuple[float, float]
    cached_routes: bool
    timings_ms: dict[str, float]
    attribution: list[str]


class PlanOut(Schema):
    request: RequestEcho
    routes: list[RouteOut]
    recommendation: Recommendation
    corridor: Corridor
    meta: Meta


class Relay(Schema):
    url: str
    form: dict[str, str] = Field(description="Send as application/x-www-form-urlencoded.")
    locations: list[tuple[float, float]]


class ErrorBody(Schema):
    code: str
    message: str
    fields: dict[str, str] | None = None
    relay: Relay | None = Field(default=None, description="Present on weather errors: the query to send instead.")


class ErrorOut(Schema):
    error: ErrorBody
