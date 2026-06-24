# InvoiceX Extraction Backend

This folder contains the invoice extraction engine for InvoiceX.

It is a standalone Django service that receives invoice images or PDFs, extracts structured invoice data with AI, validates the invoice math, stores the result, and shows processed invoices in a local dashboard.

This folder does not depend on the automation app.  
You can run it by itself, test it with curl, and use it as a normal HTTP invoice extraction API.

---

## What this backend does

The extraction backend turns invoice files into structured JSON.

It can:

- Accept invoice uploads through an HTTP endpoint.
- Support JPEG, PNG, WebP, and PDF files.
- Send invoice bytes to the AI extraction layer.
- Extract seller details, VAT number, invoice number, totals, timestamp, and line items.
- Save invoices and line items in the database.
- Validate invoice totals using line-item math.
- Mark invoices as `match`, `mismatch`, `pending`, or `failed`.
- Show all processed invoices in a dashboard.

---

## Main flow

```text
Invoice file
    ↓
POST /api/invoices/upload/
    ↓
AI extraction
    ↓
JSON parsing
    ↓
Database save
    ↓
Math validation
    ↓
Dashboard / API response
```

---

## Folder structure

```text
extraction/
├── manage.py
├── requirements.txt
├── db.sqlite3
├── KSA_Real_Invoices/
│   └── sample invoice images
│
├── invoice_backend/
│   ├── settings.py
│   ├── urls.py
│   ├── asgi.py
│   └── wsgi.py
│
├── invoices/
│   ├── models.py
│   ├── views.py
│   ├── urls.py
│   ├── admin.py
│   └── migrations/
│
└── templates/
    └── invoices/
        └── dashboard.html
```

---

## Core files

### `invoices/models.py`

Defines the database schema.

Main models:

- `Invoice`
- `InvoiceLineItem`

The `Invoice` model stores seller details, invoice totals, validation status, original file name, timestamp, and raw AI output.

The `InvoiceLineItem` model stores item name, quantity, unit price, and line total.

### `invoices/views.py`

Contains the two main views:

```text
POST /api/invoices/upload/
GET  /dashboard/
```

The upload view receives the file, calls the extractor, parses the result, saves the invoice, validates totals, and returns JSON.

The dashboard view displays invoice records and summary metrics.

### `invoice_backend/settings.py`

Loads environment variables, configures Django, sets database behavior, and reads the Gemini API key.

SQLite is used by default.  
PostgreSQL can be enabled with `DATABASE_URL`.

---

## Requirements

Install dependencies from this folder:

```powershell
cd extraction
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

Dependencies include:

- Django
- Django REST Framework
- python-dotenv
- google-genai
- Pillow
- dj-database-url
- psycopg2-binary
- whitenoise

---

## Environment variables

Create a `.env` file inside the `extraction/` folder.

```env
DEBUG=True
DJANGO_SECRET_KEY=change-this-local-secret
ALLOWED_HOSTS=localhost,127.0.0.1
GOOGLE_API_KEY=your-google-gemini-api-key
```

For PostgreSQL deployment, also add:

```env
DATABASE_URL=postgres://USER:PASSWORD@HOST:PORT/DB_NAME
```

If `DATABASE_URL` is missing, the app uses local SQLite.

---

## Important: AI extractor module

The Django app expects this import:

```python
from ai_core.gemini_extractor import extract_invoice_from_bytes
```

So the backend expects a module at:

```text
ai_core/gemini_extractor.py
```

That module should expose:

```python
extract_invoice_from_bytes(image_bytes, mime_type)
```

The function should return a JSON string.

Expected shape:

```json
{
  "seller_name": "Vendor name",
  "tax_number": "300000000000003",
  "invoice_number": "INV-001",
  "subtotal": 100.00,
  "vat_amount": 15.00,
  "total_with_vat": 115.00,
  "invoice_timestamp": "2026-06-06T19:48:00+03:00",
  "line_items": [
    {
      "item_name": "Item name",
      "quantity": 1,
      "unit_price": 100.00,
      "line_total": 100.00
    }
  ]
}
```

If this module is missing, the Django server will fail when loading the invoice upload view.

---

## Run locally

From the `extraction/` folder:

```powershell
python manage.py migrate
python manage.py runserver
```

The backend runs at:

```text
http://127.0.0.1:8000
```

---

## Upload endpoint

Upload one invoice:

```http
POST /api/invoices/upload/
Content-Type: multipart/form-data
Form field: file
```

PowerShell example:

```powershell
curl.exe -X POST "http://127.0.0.1:8000/api/invoices/upload/" `
  -F "file=@KSA_Real_Invoices/IMG_20260606_194836243.webp"
```

Supported file types:

```text
image/jpeg
image/jpg
image/png
image/webp
application/pdf
```

---

## Example success response

```json
{
  "success": true,
  "invoice_id": "5d3b2f58-0000-0000-0000-000000000000",
  "invoice_number": "INV-001",
  "seller_name": "Vendor name",
  "total_with_vat": "115.00",
  "vat_amount": "15.00",
  "validation_status": "match",
  "validation_delta": "0.00",
  "line_items_count": 1,
  "line_items": [
    {
      "item_name": "Item name",
      "quantity": "1.000",
      "unit_price": "100.00",
      "line_total": "100.00"
    }
  ]
}
```

---

## Example error responses

No file uploaded:

```json
{
  "error": "No file uploaded. Use field name 'file'."
}
```

Unsupported file type:

```json
{
  "error": "Unsupported file type: text/plain. Allowed: JPEG, PNG, WebP, PDF."
}
```

AI returned invalid JSON:

```json
{
  "error": "AI extraction failed — could not parse response.",
  "invoice_id": "5d3b2f58-0000-0000-0000-000000000000"
}
```

---

## Dashboard

Open:

```text
http://127.0.0.1:8000/dashboard/
```

The dashboard shows:

- Total invoices
- Total invoice value
- Total VAT
- Match count
- Mismatch count
- Failed count
- Pending count
- Extracted invoice rows
- Line items
- Validation status

---

## Validation logic

The backend validates invoice math using:

```text
computed subtotal = sum(quantity × unit_price)
computed total with VAT = computed subtotal + VAT amount
```

Then it compares:

```text
computed total with VAT
vs
extracted total with VAT
```

Tolerance:

```text
±0.05 SAR
```

Statuses:

```text
match     = totals are within tolerance
mismatch  = totals are outside tolerance
pending   = not enough data yet
failed    = extraction or JSON parsing failed
```

---

## Database behavior

Local development uses SQLite:

```text
db.sqlite3
```

Production can use PostgreSQL by setting:

```env
DATABASE_URL=postgres://USER:PASSWORD@HOST:PORT/DB_NAME
```

The app uses `dj-database-url` to switch automatically when `DATABASE_URL` exists.

---

## Development notes

Do not commit:

- Real customer invoices
- Production databases
- API keys
- `.env` files
- Secret keys

The sample images in `KSA_Real_Invoices/` are for local testing only.

---

## Troubleshooting

### `ModuleNotFoundError: No module named 'ai_core'`

The AI extractor module is missing.

Expected path:

```text
ai_core/gemini_extractor.py
```

Expected function:

```python
extract_invoice_from_bytes(image_bytes, mime_type)
```

### Upload returns `415 Unsupported file type`

Check that the uploaded file is one of:

```text
JPEG, PNG, WebP, PDF
```

### Upload returns `422`

The AI layer returned invalid JSON or an extraction error.

Check:

- `GOOGLE_API_KEY`
- Extractor implementation
- Server logs
- The uploaded invoice image quality

### Dashboard is empty

Process at least one invoice through:

```text
POST /api/invoices/upload/
```

Then refresh:

```text
/dashboard/
```
