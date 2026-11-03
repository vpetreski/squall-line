from django.conf import settings
from django.http import FileResponse, HttpRequest, HttpResponseNotFound
from django.http.response import HttpResponseBase


def spa(request: HttpRequest) -> HttpResponseBase:
    """The built single-page app, for any path that is not an API or static file (on Vercel the CDN serves it)."""
    index = settings.SPA_DIR / "index.html"
    if not index.is_file():
        return HttpResponseNotFound("The web app is not built. Run `npm run build` in frontend/, or open /api/docs.")
    return FileResponse(index.open("rb"), content_type="text/html; charset=utf-8")
