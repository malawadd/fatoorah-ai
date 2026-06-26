param(
  [Parameter(Mandatory = $true, Position = 0)]
  [ValidateSet("start", "stop", "status")]
  [string]$Action,

  [int]$ApiPort = 8787,

  [int]$WebPort = 5173,

  [switch]$NoEnvUpdate
)

$ErrorActionPreference = "Stop"

$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$DataDir = Join-Path $Root ".data"
$TunnelFile = Join-Path $DataDir "tunnels.json"
$ApiLog = Join-Path $DataDir "cloudflare-api.log"
$WebLog = Join-Path $DataDir "cloudflare-web.log"
$ApiPidFile = Join-Path $DataDir "cloudflare-api.pid"
$WebPidFile = Join-Path $DataDir "cloudflare-web.pid"

function Ensure-DataDir {
  New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
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

function Stop-Tunnel {
  param(
    [string]$Name,
    [string]$PidFile,
    [string]$LogFile,
    [int]$Port
  )

  if (Test-Path $PidFile) {
    $pidValue = (Get-Content $PidFile -Raw).Trim()
    if ($pidValue -match "^\d+$") {
      Stop-ProcessTree -ProcessId ([int]$pidValue)
    }
    Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
  }

  Get-CimInstance Win32_Process |
    Where-Object {
      $_.CommandLine -like "*$LogFile*" -or
      $_.CommandLine -like "*cloudflared*tunnel*--url http://localhost:$Port*"
    } |
    ForEach-Object {
      Stop-ProcessTree -ProcessId $_.ProcessId
    }

  Write-Host "Stopped $Name tunnel if it was running."
}

function Start-Tunnel {
  param(
    [string]$Name,
    [int]$Port,
    [string]$LogFile,
    [string]$PidFile,
    [string]$HealthPath
  )

  $localUrl = "http://localhost:$Port$HealthPath"
  Invoke-WebRequest -Uri $localUrl -UseBasicParsing -TimeoutSec 10 | Out-Null

  Remove-Item -LiteralPath $LogFile -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue

  $command = "Set-Location -LiteralPath '$Root'; npx --yes cloudflared tunnel --url http://localhost:$Port *> '$LogFile'"
  $process = Start-Process `
    -FilePath "powershell.exe" `
    -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", $command) `
    -WindowStyle Hidden `
    -PassThru
  Set-Content -LiteralPath $PidFile -Value $process.Id

  $url = $null
  $deadline = (Get-Date).AddSeconds(120)
  while ((Get-Date) -lt $deadline -and -not $url) {
    Start-Sleep -Seconds 2
    if (Test-Path $LogFile) {
      $log = Get-Content $LogFile -Raw
      if ($log -match "https://[a-zA-Z0-9-]+\.trycloudflare\.com") {
        $url = $Matches[0]
      }
    }
  }

  if (-not $url) {
    $logText = if (Test-Path $LogFile) { Get-Content $LogFile -Raw } else { "" }
    throw "$Name tunnel did not emit a public URL. Log: $logText"
  }

  $publicOk = $false
  $deadline = (Get-Date).AddSeconds(60)
  while ((Get-Date) -lt $deadline -and -not $publicOk) {
    Start-Sleep -Seconds 2
    try {
      Invoke-WebRequest -Uri "$url$HealthPath" -UseBasicParsing -TimeoutSec 15 | Out-Null
      $publicOk = $true
    } catch {
      $publicOk = $false
    }
  }

  if (-not $publicOk) {
    throw "$Name tunnel URL was created but did not pass health check: $url$HealthPath"
  }

  [PSCustomObject]@{
    name = $Name
    port = $Port
    url = $url
    pid = $process.Id
    log = $LogFile
  }
}

function Start-TunnelWithRetry {
  param(
    [string]$Name,
    [int]$Port,
    [string]$LogFile,
    [string]$PidFile,
    [string]$HealthPath,
    [int]$Attempts = 3
  )

  $lastError = $null
  for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
    try {
      if ($attempt -gt 1) {
        Write-Host "Retrying $Name tunnel, attempt $attempt of $Attempts..."
      }
      return Start-Tunnel -Name $Name -Port $Port -LogFile $LogFile -PidFile $PidFile -HealthPath $HealthPath
    } catch {
      $lastError = $_
      Stop-Tunnel -Name $Name -PidFile $PidFile -LogFile $LogFile -Port $Port
      if ($attempt -lt $Attempts) {
        Start-Sleep -Seconds 5
      }
    }
  }

  throw $lastError
}

function Update-EnvValue {
  param(
    [string]$Key,
    [string]$Value
  )

  $envPath = Join-Path $Root ".env"
  $line = "$Key=$Value"
  if (-not (Test-Path $envPath)) {
    Set-Content -LiteralPath $envPath -Value $line
    return
  }

  $content = Get-Content $envPath
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
  Set-Content -LiteralPath $envPath -Value $updated
}

function Show-Status {
  if (Test-Path $TunnelFile) {
    Get-Content $TunnelFile
  } else {
    Write-Host "No tunnel metadata file found at $TunnelFile."
  }

  $listeners = Get-NetTCPConnection -LocalPort @($ApiPort, $WebPort) -State Listen -ErrorAction SilentlyContinue |
    Select-Object LocalPort, OwningProcess
  if ($listeners) {
    $listeners | Format-Table
  } else {
    Write-Host "No local listeners found on ports $ApiPort or $WebPort."
  }
}

Ensure-DataDir

switch ($Action) {
  "start" {
    Stop-Tunnel -Name "API" -PidFile $ApiPidFile -LogFile $ApiLog -Port $ApiPort
    Stop-Tunnel -Name "Web" -PidFile $WebPidFile -LogFile $WebLog -Port $WebPort

    $api = Start-TunnelWithRetry -Name "api" -Port $ApiPort -LogFile $ApiLog -PidFile $ApiPidFile -HealthPath "/api/health"
    $web = Start-TunnelWithRetry -Name "web" -Port $WebPort -LogFile $WebLog -PidFile $WebPidFile -HealthPath "/"

    $metadata = [PSCustomObject]@{
      createdAt = (Get-Date).ToString("o")
      api = $api
      web = $web
    }
    $metadata | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $TunnelFile

    if (-not $NoEnvUpdate) {
      Update-EnvValue -Key "PUBLIC_API_BASE_URL" -Value $api.url
      Update-EnvValue -Key "PUBLIC_WEB_APP_URL" -Value $web.url
      Write-Host "Updated .env PUBLIC_API_BASE_URL=$($api.url)"
      Write-Host "Updated .env PUBLIC_WEB_APP_URL=$($web.url)"
    }

    Write-Host ""
    Write-Host "API tunnel: $($api.url)" -ForegroundColor Green
    Write-Host "Web tunnel: $($web.url)" -ForegroundColor Green
    Write-Host ""
    Write-Host "Open the Web tunnel on the phone. Use the API tunnel for Maestro callbacks."
  }

  "stop" {
    Stop-Tunnel -Name "API" -PidFile $ApiPidFile -LogFile $ApiLog -Port $ApiPort
    Stop-Tunnel -Name "Web" -PidFile $WebPidFile -LogFile $WebLog -Port $WebPort
    Remove-Item -LiteralPath $TunnelFile -Force -ErrorAction SilentlyContinue
  }

  "status" {
    Show-Status
  }
}
