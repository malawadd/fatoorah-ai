# Maestro Tunnel Rotation Findings

## What Happened

The failed Maestro task was not using a hardcoded URL from the UiPath package. It was using the `apiBaseUrl` input that the backend passed when it started that Case instance.

The batch `ba757084-87d2-4fee-8176-a7870d204e3c` was started with:

```text
https://fossil-pollution-stephanie-magnificent.trycloudflare.com
```

After the tunnel rotated, that Cloudflare hostname no longer existed, so `QoyodCaseRegisterCapturePayload` failed with a DNS lookup error.

## Root Cause

The tunnel script updated `.env`, but the Express API process had already loaded `.env` at startup. Node kept the old `PUBLIC_API_BASE_URL` in memory and passed that stale value to the next Maestro Case start.

The Case artifact and API Workflows are designed correctly for tunnel rotation:

- The Case has `apiBaseUrl` and `webAppUrl` as start inputs.
- API Workflows call `vars.apiBaseUrl`.
- The backend decides the value at Case start time.

So the fix is local runtime configuration refresh, not repackaging the UiPath solution.

## Fix Implemented

The backend now refreshes tunnel-related `.env` keys before:

- Building the `uip maestro case process run` input payload.
- Constructing callback URLs for extraction and Case progress.
- Reporting runtime config through `/api/runtime/config`.

The new diagnostics endpoint returns non-secret runtime state:

```text
GET /api/runtime/config
```

It includes the effective public API URL, web URL, and booleans showing whether live UiPath Case start is enabled and configured.

## New Scripts

Sync the current tunnel URLs into `.env`, verify Cloudflare, verify the running backend sees the same URLs, and run Maestro preflight:

```powershell
.\scripts\sync-maestro-tunnel.ps1
```

If the running API was started before this fix or you want a clean process:

```powershell
.\scripts\sync-maestro-tunnel.ps1 -RestartApi
```

Start fresh tunnels and immediately sync Maestro config:

```powershell
.\scripts\dev-tunnels.ps1 start -SyncMaestro
```

Start fresh tunnels, restart the API process, and sync Maestro config:

```powershell
.\scripts\dev-tunnels.ps1 start -SyncMaestro -RestartApi
```

Run a live public API smoke test named `demo test`:

```powershell
.\scripts\maestro-tunnel-smoke.ps1 -BatchName "demo test"
```

The smoke test uploads a tiny PDF through the public API tunnel, starts a real Maestro Case, and verifies the batch record shows:

- The fresh `PUBLIC_API_BASE_URL` was included in the Case start command.
- A Maestro callback such as `RegisterCapturePayload` reached the backend.

## Deployment Answer

You do not need to redeploy the UiPath package every time the Cloudflare tunnel URL changes.

Redeployment is only needed when the Case definition, API Workflow JSON, package bindings, or process resources change. A tunnel rotation only changes Case start input values, so the local backend and `.env` are enough.

## Important Limit

Existing in-flight Case instances keep the URL they were started with. If a Case was started with an expired tunnel URL, it cannot magically switch to the new tunnel because the value is already stored as that Case instance's input variable.

For an old failed Case:

1. Restore the old tunnel hostname if possible, or
2. Cancel/ignore that failed Case and create a fresh batch/Case after running the sync script.

New Case instances will use the current tunnel URL.
