# Tunneling: Exposing the Dev Server to the World

This app exposes its local development server to the internet so that **a phone browser, Maestro cloud callbacks, and UiPath Orchestrator** can reach the API and PWA without a full deployment. The entire approach uses [**Cloudflare Tunnel (`cloudflared`)**](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) — no fixed DNS, no static IP, no ngrok account required.

---

## Two Tunnels, One Script

The app runs two separate local processes:

| Service | Port | Tool | Purpose |
|---------|------|------|---------|
| **API** (Express) | `8787` | `tsx watch src/server/index.ts` | Invoice capture, LLM extraction, batch management, Maestro callbacks |
| **Web** (Vite) | `5173` | `vite --host 0.0.0.0` | React PWA — the UI used on desktop and mobile |

Each gets its own Cloudflare tunnel, producing two public `*.trycloudflare.com` URLs.

```
┌─────────────────────────────────────┐
│         Your Dev Machine            │
│                                     │
│  ┌──────────┐    ┌──────────────┐   │
│  │ Vite dev │    │ Express API  │   │
│  │ :5173    │    │ :8787        │   │
│  └────┬─────┘    └─────┬────────┘   │
│       │                │            │
│  ┌────▼─────┐    ┌─────▼────────┐   │
│  │cloudflared│    │ cloudflared  │   │
│  │ tunnel    │    │ tunnel       │   │
│  └────┬─────┘    └─────┬────────┘   │
│       │                │            │
└───────┼────────────────┼────────────┘
        │                │
        ▼                ▼
https://xxx-xxx.trycloudflare.com  (Web)
https://yyy-yyy.trycloudflare.com  (API)
```

---

## How It Works

### 1. Cloudflare Tunnel (`cloudflared`)

The script runs `npx cloudflared tunnel --url http://localhost:<PORT>` for each service. Cloudflare's edge picks up the tunnel connection and assigns a random subdomain under `trycloudflare.com`. No registration, no API key — it just works.

### 2. Health Checks

Before declaring a tunnel ready, the script:

1. **Pre-check** — verifies the local server is listening by hitting the health endpoint.
2. **URL extraction** — tail the tunnel log until a `https://*-*.trycloudflare.com` pattern appears (up to 120 seconds).
3. **Post-check** — hit the public URL's health endpoint to confirm the tunnel is actually routing traffic (up to 60 seconds).

If any step fails, the tunnel is killed and retried (up to 3 attempts).

### 3. Auto-Update `.env`

Once both tunnels are live, the script writes the API tunnel URL into `.env` as `PUBLIC_API_BASE_URL`. This is consumed by the Express server when constructing callback URLs for Maestro.

---

## Vite Configuration for Tunnels

The Vite dev server (`vite.config.ts`) has two tunnel-related settings:

```ts
server: {
  port: 5173,
  allowedHosts: [".trycloudflare.com", ".loca.lt"],  // ← allows tunnel hostnames
  proxy: {
    "/api": "http://localhost:8787"                   // ← forwards /api calls to Express
  }
}
```

- **`allowedHosts`** — By default Vite rejects requests with unrecognised `Host` headers. `trycloudflare.com` and `loca.lt` are whitelisted so the tunnel works.
- **`/api` proxy** — The web tunnel only exposes Vite. API calls from the browser go to `/api/*`, which Vite proxies to `localhost:8787`. This avoids CORS issues and means the phone only needs the web tunnel URL.

---

## Firewall (Local Network Fallback)

The script `scripts/dev-firewall.ps1` opens a port in the Windows Firewall for **direct local-network access** (no tunnel). This is useful for quick phone tests on the same Wi-Fi.

```
scripts/dev-firewall.ps1 open     # open TCP 5173 on Private network
scripts/dev-firewall.ps1 close    # close it
scripts/dev-firewall.ps1 status   # check current state
scripts/dev-firewall.ps1 session  # open + wait + auto-close on exit
```

The `session` action is also accessible via `scripts/phone-test-session.cmd` (double-click friendly). It opens the port, waits for you to test, then closes it when you press Enter.

---

## The Script: `scripts/dev-tunnels.ps1`

### Usage

```powershell
# Start both tunnels
.\scripts\dev-tunnels.ps1 start

# Start with custom ports
.\scripts\dev-tunnels.ps1 start -ApiPort 8787 -WebPort 5173

# Skip .env update
.\scripts\dev-tunnels.ps1 start -NoEnvUpdate

# Check tunnel status
.\scripts\dev-tunnels.ps1 status

# Stop both tunnels
.\scripts\dev-tunnels.ps1 stop
```

### What `start` Does

1. Kills any existing tunnel processes (by PID file and by matching command lines).
2. Starts the **API** tunnel — waits for health check on `/api/health`.
3. Starts the **Web** tunnel — waits for health check on `/`.
4. Writes metadata to `.data/tunnels.json`.
5. Updates `.env` with the new `PUBLIC_API_BASE_URL` (unless `-NoEnvUpdate`).

### What `stop` Does

- Kills the tunnel process trees (parent + children).
- Cleans up PID files and removes `tunnels.json`.

### Data Files (all inside `.data/`)

| File | Purpose |
|------|---------|
| `tunnels.json` | Metadata from the last `start` |
| `cloudflare-api.log` | Raw cloudflared output for the API tunnel |
| `cloudflare-web.log` | Raw cloudflared output for the web tunnel |
| `cloudflare-api.pid` | Process ID of the API tunnel process |
| `cloudflare-web.pid` | Process ID of the web tunnel process |

---

## Maestro Preflight Validation

After starting tunnels, run the preflight script to verify everything is wired correctly:

```powershell
.\scripts\maestro-preflight.ps1
```

It checks:
- All required environment variables are set (`PUBLIC_API_BASE_URL`, `CASE_CALLBACK_TOKEN`, `UIPATH_ENABLED`, etc.).
- The `PUBLIC_API_BASE_URL` is a reachable public HTTPS URL (not localhost).
- UiPath CLI is installed and authenticated.
- The Case plan file exists.
- An Orchestrator asset can be updated to the current tunnel URL.

---

## End-to-End Flow

```
1. npm run dev                    → starts API (:8787) + Vite (:5173)
2. .\scripts\dev-tunnels.ps1 start → creates two trycloudflare.com URLs
3. Open web tunnel URL on phone   → phone hits Vite, Vite proxies /api → Express
4. Maestro calls API tunnel URL   → cloud callback reaches Express directly
5. .\scripts\dev-tunnels.ps1 stop  → tears down both tunnels
```

### Who Uses Which URL

| URL | Used By | Why |
|-----|---------|-----|
| **Web tunnel** (`*.trycloudflare.com`) | Phone browser, desktop browser | PWA frontend; API calls go through Vite's proxy |
| **API tunnel** (`*.trycloudflare.com`) | Maestro cloud callbacks, UiPath Orchestrator | Direct HTTPS access to Express endpoints |
| **Firewall IP** (`http://192.168.x.x:5173`) | Phone on same Wi-Fi | Direct local-network testing without a tunnel |

---

## Why Cloudflare Tunnel?

| Requirement | Solution |
|-------------|----------|
| Public HTTPS URL for phone testing | `cloudflared` gives `https://*.trycloudflare.com` |
| Maestro cloud callbacks need a reachable endpoint | API tunnel provides public ingress |
| No static IP or DNS management | Ephemeral subdomain per tunnel session |
| No account registration | `trycloudflare.com` is free and anonymous |
| Works behind corporate VPNs/Firewalls | Outbound-only TCP connection to Cloudflare edge |
