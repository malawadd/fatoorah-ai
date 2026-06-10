"""
invoice_backend/urls.py
────────────────────────
Root URL configuration for the Agentic Minds project.
"""

from django.contrib import admin
from django.urls import path, include
from django.views.generic import RedirectView

urlpatterns = [
    # Admin panel
    path("admin/", admin.site.urls),

    # Redirect root → dashboard
    path("", RedirectView.as_view(url="/dashboard/", permanent=False)),

    # Include all invoices app routes (uploads + dashboard)
    path("", include("invoices.urls", namespace="invoices")),
]