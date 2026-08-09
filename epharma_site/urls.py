from django.urls import include, path, re_path
from api import views

urlpatterns = [
    path("api/", include("api.urls")),
    re_path(r"^api/", views.api_not_found),          # unknown /api/* -> JSON 404
    re_path(r"^(?P<path>.*)$", views.serve_public),  # SPA + static (public/)
]
