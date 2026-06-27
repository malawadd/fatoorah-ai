param(
  [string]$ApiUrl,
  [string]$WebUrl,
  [int]$ApiPort = 8787,
  [int]$WebPort = 5173,
  [switch]$RestartApi,
  [switch]$SkipPreflight
)

$ErrorActionPreference = "Stop"

$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$DataDir = Join-Path $Root ".data"
$TunnelFile = Join-Path $DataDir "tunnels.json"
$EnvPath = Join-Path $Root ".env"
$ApiDevLog = Join-Path $DataDir "api-dev.log"

function Normalize-Url {
  param([string]$Url)
  if (-not $Url) {
    return ""
  }
  return $Url.Trim().TrimEnd("/")
}

function Read-TunnelMetadata {
  if (-not (Test-Path $TunnelFile)) {
    throw "No tunnel metadata found at $TunnelFile. Start tunnels first with scripts\dev-tunnels.ps1 start."
  }
  return Get-Content $TunnelFile -Raw | ConvertFrom-Json
}

function Update-EnvValue {
  param(
    [string]$Key,
    [string]$Value
  )

  $line = "$Key=$Value"
  if (-not (Test-Path $EnvPath)) {
    Set-Content -LiteralPath $EnvPath -Value $line
    return
  }

  $content = Get-Content $EnvPath
  $found = $false
  $updated = $content | ForEach-Object {
    if ($_ -match "^\s*$([regex]::Escape($Key))=") {
      $found = $true
      $line
    } else {
      $_
    }
  }
  if (-not $found) {
    $updated += $line
  }
  Set-Content -LiteralPath $EnvPath -Value $updated
}

function Invoke-Json {
  param([string]$Url)
  Invoke-RestMethod -Uri $Url -TimeoutSec 20
}

function Test-Http {
  param(
    [string]$Name,
    [string]$Url
  )

  try {
    Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 20 | Out-Null
    Write-Host "[OK] $Name reachable: $Url"
  } catch {
    throw "$Name is not reachable at $Url. $($_.Exception.Message)"
  }
}

function Get-ChildrenByParent {
  param([int]$ParentPid)
  Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq $ParentPid }
}

function Stop-ProcessTree {
  param([int]$ProcessId)

  Get-ChildrenByParent $ProcessId | ForEach-Object {
    Stop-ProcessTree -ProcessId $_.ProcessId
  }

  Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
}

function Restart-ApiDevServer {
  $healthUrl = "http://localhost:$ApiPort/api/health"
  $health = $null
  try {
    $health = Invoke-Json $healthUrl
  } catch {
    $health = $null
  }

  $listeners = Get-NetTCPConnection -LocalPort $ApiPort -State Listen -ErrorAction SilentlyContinue
  foreach ($listener in $listeners) {
    if ($health -and $health.service -eq "qoyod-invoice-intake-api") {
      Write-Host "Stopping existing Qoyod API listener on port $ApiPort (PID $($listener.OwningProcess))."
      Stop-ProcessTree -ProcessId $listener.OwningProcess
    } else {
      throw "Port $ApiPort is in use but does not look like qoyod-invoice-intake-api. Stop it manually or pass a different -ApiPort."
    }
  }

  New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
  Remove-Item -LiteralPath $ApiDevLog -Force -ErrorAction SilentlyContinue
  $command = "Set-Location -LiteralPath '$Root'; npm run dev:api *> '$ApiDevLog'"
  Start-Process `
    -FilePath "powershell.exe" `
    -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", $command) `
    -WindowStyle Hidden | Out-Null

  $deadline = (Get-Date).AddSeconds(60)
  while ((Get-Date) -lt $deadline) {
    try {
      $started = Invoke-Json $healthUrl
      if ($started.service -eq "qoyod-invoice-intake-api") {
        Write-Host "[OK] API dev server restarted on port $ApiPort."
        return
      }
    } catch {
      Start-Sleep -Seconds 2
    }
  }

  $logText = if (Test-Path $ApiDevLog) { Get-Content $ApiDevLog -Raw } else { "" }
  throw "API dev server did not restart within 60 seconds. Log: $logText"
}

if (-not $ApiUrl -or -not $WebUrl) {
  $metadata = Read-TunnelMetadata
  if (-not $ApiUrl) {
    $ApiUrl = $metadata.api.url
  }
  if (-not $WebUrl) {
    $WebUrl = $metadata.web.url
  }
}

$ApiUrl = Normalize-Url $ApiUrl
$WebUrl = Normalize-Url $WebUrl

if (-not $ApiUrl -or -not $WebUrl) {
  throw "Both API and web tunnel URLs are required."
}

New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
Update-EnvValue -Key "PUBLIC_API_BASE_URL" -Value $ApiUrl
Update-EnvValue -Key "PUBLIC_WEB_APP_URL" -Value $WebUrl
Write-Host "[OK] .env updated with current tunnel URLs."

if ($RestartApi) {
  Restart-ApiDevServer
}

Test-Http -Name "API tunnel health" -Url "$ApiUrl/api/health"
Test-Http -Name "Web tunnel" -Url "$WebUrl/"

$localConfig = Invoke-Json "http://localhost:$ApiPort/api/runtime/config"
$publicConfig = Invoke-Json "$ApiUrl/api/runtime/config"

if ($localConfig.publicApiBaseUrl -ne $ApiUrl) {
  throw "Running backend still reports PUBLIC_API_BASE_URL=$($localConfig.publicApiBaseUrl), expected $ApiUrl. Restart with -RestartApi or check .env loading."
}

if ($localConfig.publicWebAppUrl -ne $WebUrl) {
  throw "Running backend still reports PUBLIC_WEB_APP_URL=$($localConfig.publicWebAppUrl), expected $WebUrl. Restart with -RestartApi or check .env loading."
}

Write-Host "[OK] Local backend effective API URL: $($localConfig.publicApiBaseUrl)"
Write-Host "[OK] Local backend effective web URL: $($localConfig.publicWebAppUrl)"
Write-Host "[OK] Public backend config endpoint reachable: $($publicConfig.publicApiBaseUrl)"

if (-not $SkipPreflight) {
  & (Join-Path $PSScriptRoot "maestro-preflight.ps1")
  if ($LASTEXITCODE -ne 0) {
    throw "Maestro preflight failed."
  }
}

Write-Host "Tunnel sync complete. New Maestro Case starts will use $ApiUrl."
