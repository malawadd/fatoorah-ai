

from django.urls import path
from . import views

app_name = "invoices"

urlpatterns = [
    # API endpoint — UiPath / any HTTP client posts invoices here
    path(
        "api/invoices/upload/",
        views.upload_and_process_invoice,
        name="upload",
    ),

    # Human-facing dashboard
    path(
        "dashboard/",
        views.dashboard,
        name="dashboard",
    ),
]