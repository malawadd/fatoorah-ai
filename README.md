# 🤖 Agentic Minds: SmartInvoice

An enterprise-grade, backend-driven automation pipeline designed for the Saudi Arabian and Gulf markets. **SmartInvoice** completely eliminates manual data entry by orchestrating AI extraction, automated financial auditing, and ZATCA compliance verification, seamlessly transferring physical invoices into the **Qoyod** accounting system with zero human input.

---

## 💡 Inspiration
Every day, finance teams across the region manually key hundreds of invoices into ERP and accounting systems. Each invoice takes 3–5 minutes of human time — and a single typo can result in ZATCA compliance failures, delayed payments, or heavy VAT penalties. 

We asked ourselves: *What if the entire process — from receiving an invoice photo to having it officially drafted in Qoyod — required zero human input?* That question became the foundation of **Agentic Minds**.

---

## 🚀 Key Features
* **Intelligent AI Extraction:** Powered by Google Gemini to parse multi-line items, handwritten details, and complex Arabic typography.
* **ZATCA QR Base64 Decoder:** A custom-built Python decoder that extracts binary TLV (Tag-Length-Value) metadata straight from the invoice's QR code to establish cryptographic ground truth.
* **Automated Financial Auditor:** Background mathematical validation that instantly catches mathematical discrepancies down to the decimal point.
* **Production Resilience:** Implements an advanced retry algorithm to defend against network fluctuations and API rate limits.
* **Session-Based RPA Filling:** A secure Chrome Extension that fills forms inside the active user session, keeping humans in control without needing expensive api licenses.

---

## 🔨 System Architecture & How It Works

1.  **Capture Layer (UiPath Maestro):** A UiPath Maestro Case orchestrates the ingestion. Invoice images captured via a mobile PWA or file system are immediately forwarded via an HTTP POST request to our Django REST API.
2.  **Intelligence Layer (Gemini + Django Backend):** Django receives the raw image bytes and coordinates with **Google Gemini**. Gemini extracts all individual line items, vendor details, and core totals.
3.  **Validation Engine:** The custom engine computes the expected financial balance using the following logic:
    $$\text{Computed Total} = \sum(\text{Quantity}_i \times \text{Price}_i) + \text{VAT}$$
    It cross-references this computed total against the ZATCA QR-reported total. A delta within $\pm0.05$ SAR marks the invoice as ✅ **Match**; anything beyond is flagged ⚠️ **Mismatch**.
4.  **Storage & Review:** All structured invoice records, audit trails, and mismatch flags are persisted in the database and displayed on a beautiful, custom dark-themed monitoring dashboard.
5.  **Execution Layer (Chrome Extension - Qoyod Filler):** The custom extension reads the validated data and auto-populates the Qoyod accounting form. To ensure full security, it saves the entry as a **Draft only**, requiring a final human click to submit.

---

## 🚧 Challenges Faced & Resolutions

* **No Commercial Document Understanding License:** We completely bypassed traditional paid extraction engines by engineering precise, strict semantic prompts on Gemini, resulting in higher accuracy for local Arabic invoices.
* **The Subtotal Validation Bug:** Mid-build, we discovered that comparing line-item subtotals directly against the VAT-inclusive QR total created false mismatch errors. We resolved this by explicitly mapping tax weights before the final assertion phase:
    $$\text{Computed with VAT} = \text{Subtotal} + \text{VAT Amount}$$
* **Transient 503 API Overloads:** Under heavy request loads, external AI endpoints can drop connections. We wrapped the extraction layer in an **Exponential Backoff with Jitter** retry mechanism (up to 5 attempts, capped at 30 seconds) to ensure enterprise stability.

---

## 🛠️ Tech Stack
* **Backend Framework:** Python / Django (REST API)
* **AI Engine:** Google Gemini API
* **Orchestration:** UiPath Maestro Cases
* **Automation/Frontend:** Node.js / PWA / Chrome Extension Architecture
* **Database:** PostgreSQL / SQLite
* **Formatting/Math:** LaTeX Validation Formulas

---

## 📚 What We Learned
* Modern Large Language Models are exceptionally capable of processing structured document data and parsing dense regional language patterns when guided by rigid prompt engineering.
* System resiliency (such as randomized backoff retries and dynamic mathematical tolerance limits) is just as critical to an enterprise pipeline as the underlying machine learning accuracy.
* High-impact enterprise automation can be built successfully without restrictive premium licensing by utilizing open-source frameworks, flexible browser extensions, and agile AI APIs.
