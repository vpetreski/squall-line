"""Settings come from the environment, and from `.env` at the repository root for a local run (the real
environment wins). See `.env.example` for every setting.

The service is stateless: no database, no sessions, no admin. Upstream responses are cached in Django's cache
(process memory by default, Redis when `REDIS_URL` is set).
"""

import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
REPO_DIR = BASE_DIR.parent


def load_dotenv(path: Path) -> None:
    """`KEY=value` lines of a local `.env` into the environment, never over a variable that is already set."""
    if not path.is_file():
        return
    for raw in path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.removeprefix("export ").strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
            value = value[1:-1]
        os.environ.setdefault(key, value)


load_dotenv(REPO_DIR / ".env")


def env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


def env_bool(name: str, default: bool = False) -> bool:
    value = env(name)
    return default if not value else value.lower() in {"1", "true", "yes", "on"}


def env_list(name: str, default: str) -> list[str]:
    return [item.strip() for item in env(name, default).split(",") if item.strip()]


DEBUG = env_bool("DJANGO_DEBUG")
# Nothing is signed (no sessions, cookies or tokens), so the key only has to exist; production sets its own.
SECRET_KEY = env("DJANGO_SECRET_KEY", "development-only-key")

ALLOWED_HOSTS = env_list("DJANGO_ALLOWED_HOSTS", "localhost,127.0.0.1,[::1],.vercel.app")
CSRF_TRUSTED_ORIGINS = env_list("DJANGO_CSRF_TRUSTED_ORIGINS", "https://*.vercel.app")

INSTALLED_APPS = ["planner"]

MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "whitenoise.middleware.WhiteNoiseMiddleware",
    "django.middleware.gzip.GZipMiddleware",
    "django.middleware.common.CommonMiddleware",
]

ROOT_URLCONF = "config.urls"
WSGI_APPLICATION = "config.wsgi.application"
DATABASES: dict[str, dict[str, str]] = {}
# Only for the API's interactive docs page, which django-ninja renders from a template (Swagger UI from a CDN).
TEMPLATES: list[dict[str, object]] = [{"BACKEND": "django.template.backends.django.DjangoTemplates"}]

USE_TZ = True
TIME_ZONE = "UTC"
LANGUAGE_CODE = "en-us"
APPEND_SLASH = False

# The single-page app, when Django serves it (a local run after `npm run build`). On Vercel the CDN serves it.
SPA_DIR = Path(env("SPA_DIR", str(REPO_DIR / "frontend" / "dist")))
WHITENOISE_ROOT = SPA_DIR if SPA_DIR.is_dir() else None
WHITENOISE_MAX_AGE = 3600
# Vite names every built asset after a hash of its content, so those files can be cached forever.
WHITENOISE_IMMUTABLE_FILE_TEST = r"^/assets/.+-[A-Za-z0-9_-]{8}\.[a-z0-9]+$"

SECURE_CONTENT_TYPE_NOSNIFF = True
SECURE_REFERRER_POLICY = "strict-origin-when-cross-origin"
SECURE_CROSS_ORIGIN_OPENER_POLICY = "same-origin"

REDIS_URL = env("REDIS_URL")
CACHES = {
    "default": (
        {"BACKEND": "django.core.cache.backends.redis.RedisCache", "LOCATION": REDIS_URL}
        if REDIS_URL
        else {"BACKEND": "django.core.cache.backends.locmem.LocMemCache", "OPTIONS": {"MAX_ENTRIES": 6000}}
    )
}

LOGGING = {
    "version": 1,
    "disable_existing_loggers": False,
    "formatters": {"plain": {"format": "%(levelname)s %(name)s %(message)s"}},
    "handlers": {"console": {"class": "logging.StreamHandler", "formatter": "plain"}},
    "root": {"handlers": ["console"], "level": env("LOG_LEVEL", "INFO")},
    "loggers": {"httpx": {"level": "WARNING"}, "httpcore": {"level": "WARNING"}},
}

# Upstream services. Without a TomTom key the keyless public Valhalla and OSRM servers are used.
TOMTOM_API_KEY = env("TOMTOM_API_KEY")
ROUTING_PROVIDERS = env_list("ROUTING_PROVIDERS", "tomtom,valhalla,osrm")
VALHALLA_URL = env("VALHALLA_URL", "https://valhalla1.openstreetmap.de")
OSRM_URL = env("OSRM_URL", "https://router.project-osrm.org")
PHOTON_URL = env("PHOTON_URL", "https://photon.komoot.io")
OPEN_METEO_URL = env("OPEN_METEO_URL", "https://api.open-meteo.com/v1/forecast")
# Where a browser sends a relayed query (never with the API key): the free endpoint.
OPEN_METEO_PUBLIC_URL = env("OPEN_METEO_PUBLIC_URL", "https://api.open-meteo.com/v1/forecast")
OPEN_METEO_API_KEY = env("OPEN_METEO_API_KEY")
HTTP_USER_AGENT = env("HTTP_USER_AGENT", "squall-line/1.0 (+https://github.com/vpetreski/squall-line)")

# Planning limits.
WEATHER_LOCATION_BUDGET = int(env("WEATHER_LOCATION_BUDGET", "450"))
# A plan may carry a forecast the browser fetched itself (see planner.weather): allow a few megabytes.
DATA_UPLOAD_MAX_MEMORY_SIZE = 5 * 1024 * 1024
DEPARTURE_MAX_DAYS_AHEAD = int(env("DEPARTURE_MAX_DAYS_AHEAD", "7"))
