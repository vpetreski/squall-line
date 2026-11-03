from django.urls import path, re_path

from planner.api import api
from planner.views import spa

urlpatterns = [
    path("api/", api.urls),
    re_path(r"^(?!api/).*$", spa),
]
