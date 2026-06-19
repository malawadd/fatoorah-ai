"""
invoices/views.py
─────────────────
Two views:
  1. upload_and_process_invoice  — receives image, calls Gemini, saves to DB
  2. dashboard                   — renders the analytics + table template
"""

import json
import logging
from decimal import Decimal, InvalidOperation

from django.http import JsonResponse
from django.shortcuts import render
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_http_methods
from django.db.models import Sum, Count
from django.utils.dateparse import parse_datetime

from .models import Invoice, InvoiceLineItem
from ai_core.gemini_extractor import extract_invoice_from_bytes

logger = logging.getLogger(__name__)

# Tolerance for float comparison (e.g. rounding differences of ±0.05)
VALIDATION_TOLERANCE = Decimal("0.05")

ALLOWED_MIME_TYPES = {
    "image/jpeg": "image/jpeg",
    "image/jpg":  "image/jpeg",
    "image/png":  "image/png",
    "image/webp": "image/webp",
    "application/pdf": "application/pdf",
}


# ─────────────────────────────────────────────────────────────
#  HELPER: safe decimal conversion
# ─────────────────────────────────────────────────────────────

def _to_decimal(value) -> Decimal | None:
    """Convert int / float / str to Decimal safely. Returns None on failure."""
    if value is None:
        return None
    try:
        return Decimal(str(value).replace(",", "")).quantize(Decimal("0.01"))
    except (InvalidOperation, ValueError):
        return None


# ─────────────────────────────────────────────────────────────
#  VIEW 1: Upload & Process
# ─────────────────────────────────────────────────────────────

@csrf_exempt
@require_http_methods(["POST"])
def upload_and_process_invoice(request):
    """
    POST /api/invoices/upload/
    Accepts multipart/form-data with field name 'file'.

    Flow:
      1. Validate file type
      2. Call Gemini extractor
      3. Parse JSON response
      4. Validate: sum(line_items) vs total_with_vat from QR
      5. Persist Invoice + InvoiceLineItems
      6. Return structured JSON response
    """

    # ── 1. Validate uploaded file ──────────────────────────────────────────
    uploaded_file = request.FILES.get("file")
    if not uploaded_file:
        return JsonResponse({"error": "No file uploaded. Use field name 'file'."}, status=400)

    content_type = uploaded_file.content_type.lower()
    mime_type = ALLOWED_MIME_TYPES.get(content_type)
    if not mime_type:
        return JsonResponse(
            {"error": f"Unsupported file type: {content_type}. Allowed: JPEG, PNG, WebP, PDF."},
            status=415,
        )

    image_bytes = uploaded_file.read()
    original_name = uploaded_file.name

    # ── 2. Call Gemini ─────────────────────────────────────────────────────
    logger.info("Processing invoice: %s (%d bytes)", original_name, len(image_bytes))
    raw_result = extract_invoice_from_bytes(image_bytes, mime_type)

    # ── 3. Parse JSON ──────────────────────────────────────────────────────
    try:
        data: dict = json.loads(raw_result)
    except json.JSONDecodeError:
        logger.error("Gemini returned unparseable output for %s", original_name)
        invoice = Invoice.objects.create(
            original_file_name=original_name,
            validation_status="failed",
            raw_gemini_json={"raw": raw_result},
        )
        return JsonResponse(
            {"error": "AI extraction failed — could not parse response.", "invoice_id": str(invoice.id)},
            status=422,
        )

    if "error" in data:
        invoice = Invoice.objects.create(
            original_file_name=original_name,
            validation_status="failed",
            raw_gemini_json=data,
        )
        return JsonResponse(
            {"error": data["error"], "invoice_id": str(invoice.id)},
            status=422,
        )

    # ── 4. Extract & coerce fields ─────────────────────────────────────────
    seller_name       = data.get("seller_name")
    tax_number        = data.get("tax_number")
    invoice_number    = data.get("invoice_number")
    subtotal          = _to_decimal(data.get("subtotal"))
    vat_amount        = _to_decimal(data.get("vat_amount"))
    total_with_vat    = _to_decimal(data.get("total_with_vat"))

    # Parse invoice timestamp
    invoice_timestamp = None
    ts_raw = data.get("invoice_timestamp")
    if ts_raw:
        try:
            invoice_timestamp = parse_datetime(ts_raw)
        except (ValueError, TypeError):
            pass

    # ── 5. Compute line-item total & validate ──────────────────────────────
    line_items_raw = data.get("line_items", [])
    computed_subtotal = Decimal("0.00")
    for item in line_items_raw:
        qty   = _to_decimal(item.get("quantity"))
        price = _to_decimal(item.get("unit_price"))
        if qty and price:
            computed_subtotal += (qty * price).quantize(Decimal("0.01"))

    # Validation logic — compare like-for-like:
    #   computed_subtotal (sum of line items, VAT-exclusive)
    #   + vat_amount (from QR/Gemini)
    #   ───────────────────────────────────────────────────
    #   = computed_total_with_vat  ←→  compared against total_with_vat (QR)
    #
    # Comparing computed_subtotal directly against total_with_vat is WRONG —
    # it always shows a mismatch equal to the VAT amount, since one side
    # excludes tax and the other includes it.
    if total_with_vat is not None:
        computed_total_with_vat = computed_subtotal + (vat_amount or Decimal("0.00"))
        delta = (computed_total_with_vat - total_with_vat).copy_abs()
        validation_status = "match" if delta <= VALIDATION_TOLERANCE else "mismatch"
        validation_delta = computed_total_with_vat - total_with_vat
    else:
        validation_status = "match" if computed_subtotal > 0 else "pending"
        validation_delta = None

    # Keep computed_total name for backward compatibility below
    computed_total = computed_subtotal

    # ── 6. Persist to database ─────────────────────────────────────────────
    invoice = Invoice.objects.create(
        invoice_number=invoice_number,
        seller_name=seller_name,
        tax_number=tax_number,
        subtotal=subtotal,
        vat_amount=vat_amount,
        total_with_vat=total_with_vat if total_with_vat else computed_total,
        validation_status=validation_status,
        validation_delta=validation_delta,
        original_file_name=original_name,
        invoice_timestamp=invoice_timestamp,
        raw_gemini_json=data,
    )

    created_items = []
    for item in line_items_raw:
        qty        = _to_decimal(item.get("quantity"))
        unit_price = _to_decimal(item.get("unit_price"))
        line_total = _to_decimal(item.get("line_total"))

        # Compute line_total if missing
        if line_total is None and qty and unit_price:
            line_total = (qty * unit_price).quantize(Decimal("0.01"))

        li = InvoiceLineItem.objects.create(
            invoice=invoice,
            item_name=item.get("item_name", "Unknown Item"),
            quantity=qty,
            unit_price=unit_price,
            line_total=line_total,
        )
        created_items.append({
            "item_name":  li.item_name,
            "quantity":   str(li.quantity),
            "unit_price": str(li.unit_price),
            "line_total": str(li.line_total),
        })

    logger.info(
        "Invoice %s saved — status: %s | items: %d",
        invoice.id, validation_status, len(created_items)
    )

    # ── 7. Return response ─────────────────────────────────────────────────
    return JsonResponse({
        "success": True,
        "invoice_id":        str(invoice.id),
        "invoice_number":    invoice.invoice_number,
        "seller_name":       invoice.seller_name,
        "total_with_vat":    str(invoice.total_with_vat),
        "vat_amount":        str(invoice.vat_amount),
        "validation_status": invoice.validation_status,
        "validation_delta":  str(invoice.validation_delta) if invoice.validation_delta else None,
        "line_items_count":  len(created_items),
        "line_items":        created_items,
    }, status=201)


# ─────────────────────────────────────────────────────────────
#  VIEW 2: Dashboard
# ─────────────────────────────────────────────────────────────

def dashboard(request):
    """
    GET /dashboard/
    Renders the analytics dashboard with all invoices and summary metrics.
    Prefetches line items to avoid N+1 queries.
    """
    invoices = (
        Invoice.objects
        .prefetch_related("line_items")
        .all()
    )

    # ── Summary metrics ────────────────────────────────────────────────────
    totals = Invoice.objects.aggregate(
        total_invoices=Count("id"),
        total_value=Sum("total_with_vat"),
        total_tax=Sum("vat_amount"),
    )

    match_count    = Invoice.objects.filter(validation_status="match").count()
    mismatch_count = Invoice.objects.filter(validation_status="mismatch").count()
    failed_count   = Invoice.objects.filter(validation_status="failed").count()
    pending_count  = Invoice.objects.filter(validation_status="pending").count()

    context = {
        "invoices":       invoices,
        "total_invoices": totals["total_invoices"] or 0,
        "total_value":    totals["total_value"] or Decimal("0.00"),
        "total_tax":      totals["total_tax"] or Decimal("0.00"),
        "match_count":    match_count,
        "mismatch_count": mismatch_count,
        "failed_count":   failed_count,
        "pending_count":  pending_count,
    }

    return render(request, "invoices/dashboard.html", context)