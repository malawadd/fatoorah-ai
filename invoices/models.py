"""
invoices/models.py
──────────────────
Database schema for the Agentic Minds invoice processing pipeline.
"""

import uuid
from django.db import models


class Invoice(models.Model):
    """
    Master record created the moment an invoice image is received.
    One Invoice → many InvoiceLineItems.
    """

    VALIDATION_STATUS_CHOICES = [
        ("pending",  "Pending"),   # just uploaded, not yet processed
        ("match",    "Match"),     # table total == QR total_with_vat ✅
        ("mismatch", "Mismatch"),  # totals differ ❌
        ("failed",   "Failed"),    # Gemini or parse error
    ]

    # ── Identity ──────────────────────────────────────────────────────────
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    invoice_number = models.CharField(max_length=100, blank=True, null=True)

    # ── Seller / Vendor ───────────────────────────────────────────────────
    seller_name = models.CharField(max_length=512, blank=True, null=True)
    tax_number  = models.CharField(max_length=100, blank=True, null=True,
                                   help_text="VAT registration number (e.g. ZATCA 15-digit)")

    # ── Financial totals ──────────────────────────────────────────────────
    subtotal       = models.DecimalField(max_digits=14, decimal_places=2, null=True, blank=True)
    vat_amount     = models.DecimalField(max_digits=14, decimal_places=2, null=True, blank=True)
    total_with_vat = models.DecimalField(max_digits=14, decimal_places=2, null=True, blank=True)

    # ── Validation ────────────────────────────────────────────────────────
    validation_status = models.CharField(
        max_length=20,
        choices=VALIDATION_STATUS_CHOICES,
        default="pending",
    )
    # Difference between computed line-item total and QR-reported total
    validation_delta = models.DecimalField(
        max_digits=14, decimal_places=2, null=True, blank=True,
        help_text="table_total - qr_total; 0.00 = perfect match"
    )

    # ── Source file ───────────────────────────────────────────────────────
    original_file_name = models.CharField(max_length=512, blank=True)
    invoice_timestamp  = models.DateTimeField(null=True, blank=True,
                                              help_text="Date/time printed on the invoice")

    # ── Raw AI output (kept for audit/debugging) ──────────────────────────
    raw_gemini_json = models.JSONField(null=True, blank=True)

    # ── Record timestamps ─────────────────────────────────────────────────
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "invoices"
        ordering = ["-created_at"]
        verbose_name = "Invoice"
        verbose_name_plural = "Invoices"

    def __str__(self):
        return f"{self.seller_name or 'Unknown'} — {self.invoice_number or str(self.id)[:8]}"

    # ── Computed helpers ──────────────────────────────────────────────────
    @property
    def line_items_total(self):
        """Sum of all line-item totals (quantity × unit_price)."""
        total = sum(
            (item.quantity or 0) * (item.unit_price or 0)
            for item in self.line_items.all()
        )
        return round(total, 2)

    @property
    def is_valid(self):
        return self.validation_status == "match"


class InvoiceLineItem(models.Model):
    """
    Individual line items belonging to an Invoice.
    """

    invoice    = models.ForeignKey(
        Invoice,
        on_delete=models.CASCADE,
        related_name="line_items",
    )
    item_name  = models.CharField(max_length=512)
    quantity   = models.DecimalField(max_digits=12, decimal_places=3, null=True, blank=True)
    unit_price = models.DecimalField(max_digits=14, decimal_places=2, null=True, blank=True)
    line_total = models.DecimalField(max_digits=14, decimal_places=2, null=True, blank=True)

    class Meta:
        db_table = "invoice_line_items"
        verbose_name = "Line Item"
        verbose_name_plural = "Line Items"

    def __str__(self):
        return f"{self.item_name} (x{self.quantity}) @ {self.unit_price}"

    def save(self, *args, **kwargs):
        # Auto-compute line_total if not explicitly set
        if self.quantity is not None and self.unit_price is not None and self.line_total is None:
            self.line_total = round(float(self.quantity) * float(self.unit_price), 2)
        super().save(*args, **kwargs)