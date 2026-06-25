# Qoyod Invoice Draft Filler Side Panel

Manifest V3 Chrome side panel for the no-RPA Qoyod fill step.

## Load Locally

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Select Load unpacked.
4. Choose `extension/qoyod-filler`.
5. Pin the extension if you want the toolbar icon visible.
6. Click the toolbar icon to open the Qoyod Filler side panel.

## Configure

In the side panel:

- Set API base URL, usually `http://localhost:8787`.
- Set the fill token if the backend uses `FILLER_API_TOKEN`.
- Set Qoyod base URL, usually `https://www.qoyod.com`.
- Use Batch scope to claim from one reviewed batch only, or leave it as Any ready invoice.
- Click Save.

## Calibrate

Calibration is needed once per Qoyod form layout, and again if Qoyod changes the page.
After extension updates that add new Qoyod fields, recalibrate once so the saved selector profile has the full New Bill form.

1. Log into Qoyod in Chrome.
2. Open the purchase/simple bill draft form.
3. Click Calibrate selectors.
4. Follow the prompts on the Qoyod page and click each requested field or button.
5. Press Escape to skip optional fields such as attachment upload.

Selectors are stored in `chrome.storage.local`.

The New Bill calibration covers Reference, Bill Description, Vendor, Issue/Due/Supply dates, line mapping, line description, quantity, unit price, VAT, Add More, attachment controls, and Save Draft. The extension fills Supply Date with the Issue Date for now and never clicks Save and Approve.

## Fill Flow

- Claim next reviewed invoice calls `POST /api/fill/jobs/claim-next`, with the selected batch ID when Batch scope is set.
- Fill current Qoyod page writes the reviewed invoice draft into the active Qoyod tab.
- Save draft only asks for confirmation before clicking the calibrated save-draft button.
- Release current job returns the job to `ready_for_qoyod`.

The extension never stores Qoyod credentials and never clicks an approval or submit button.
