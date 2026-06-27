param(
  [string]$ApiUrl,
  [string]$FilePath,
  [string]$BatchName = ("demo test tunnel smoke {0}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss")),
  [int]$WaitSeconds = 120
)

$ErrorActionPreference = "Stop"

$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$DataDir = Join-Path $Root ".data"
$TunnelFile = Join-Path $DataDir "tunnels.json"

function Normalize-Url {
  param([string]$Url)
  if (-not $Url) {
    return ""
  }
  return $Url.Trim().TrimEnd("/")
}

function Read-TunnelApiUrl {
  if (-not (Test-Path $TunnelFile)) {
    throw "No tunnel metadata found at $TunnelFile. Start tunnels first with scripts\dev-tunnels.ps1 start."
  }
  $metadata = Get-Content $TunnelFile -Raw | ConvertFrom-Json
  return $metadata.api.url
}

function Ensure-DemoPdf {
  $path = Join-Path $DataDir "demo-test-invoice.pdf"
  if (Test-Path $path) {
    return $path
  }

  New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
  $pdf = @"
%PDF-1.1
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R >>
endobj
4 0 obj
<< /Length 72 >>
stream
BT /F1 12 Tf 24 100 Td (Demo Test Invoice - Tunnel Rotation Smoke) Tj ET
endstream
endobj
xref
0 5
0000000000 65535 f
0000000010 00000 n
0000000060 00000 n
0000000117 00000 n
0000000205 00000 n
trailer
<< /Size 5 /Root 1 0 R >>
startxref
328
%%EOF
"@
  [System.IO.File]::WriteAllBytes($path, [System.Text.Encoding]::ASCII.GetBytes($pdf))
  return $path
}

function Invoke-Json {
  param([string]$Url)
  Invoke-RestMethod -Uri $Url -TimeoutSec 30
}

function Upload-Batch {
  param(
    [string]$Url,
    [string]$Path,
    [string]$Name
  )

  Add-Type -AssemblyName System.Net.Http
  $client = [System.Net.Http.HttpClient]::new()
  $form = [System.Net.Http.MultipartFormDataContent]::new()
  try {
    $form.Add([System.Net.Http.StringContent]::new($Name), "batchName")
    $bytes = [System.IO.File]::ReadAllBytes($Path)
    $fileContent = [System.Net.Http.ByteArrayContent]::new($bytes)
    $fileContent.Headers.ContentType = [System.Net.Http.Headers.MediaTypeHeaderValue]::Parse("application/pdf")
    $form.Add($fileContent, "documents", [System.IO.Path]::GetFileName($Path))

    $response = $client.PostAsync("$Url/api/batches", $form).GetAwaiter().GetResult()
    $text = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
    if (-not $response.IsSuccessStatusCode) {
      throw "Upload failed with HTTP $([int]$response.StatusCode): $text"
    }
    return $text | ConvertFrom-Json
  } finally {
    $form.Dispose()
    $client.Dispose()
  }
}

if (-not $ApiUrl) {
  $ApiUrl = Read-TunnelApiUrl
}
$ApiUrl = Normalize-Url $ApiUrl
if (-not $ApiUrl) {
  throw "API tunnel URL is required."
}

if (-not $FilePath) {
  $FilePath = Ensure-DemoPdf
}
if (-not (Test-Path $FilePath)) {
  throw "Smoke file not found: $FilePath"
}

$config = Invoke-Json "$ApiUrl/api/runtime/config"
if (-not $config.uipathStartCase) {
  throw "UIPATH_START_CASE is not enabled in the running backend. The smoke test would only exercise local fallback."
}
if ($config.publicApiBaseUrl -ne $ApiUrl) {
  throw "Running backend reports $($config.publicApiBaseUrl), expected $ApiUrl. Run scripts\sync-maestro-tunnel.ps1 first."
}

Write-Host "Uploading '$BatchName' through $ApiUrl..."
$created = Upload-Batch -Url $ApiUrl -Path $FilePath -Name $BatchName
$batchId = $created.batch.batchId
if (-not $batchId) {
  throw "Batch upload response did not include a batchId."
}
Write-Host "[OK] Created batch $batchId"

$deadline = (Get-Date).AddSeconds($WaitSeconds)
$lastStage = ""
$sawFreshTunnelInCaseStart = $false
$sawRegisterCallback = $false
$sawStageAdvance = $false
$lastDetailsText = ""

while ((Get-Date) -lt $deadline) {
  $details = Invoke-Json "$ApiUrl/api/batches/$batchId"
  $lastStage = $details.batch.caseStage
  $lastDetailsText = $details | ConvertTo-Json -Depth 80
  $sawFreshTunnelInCaseStart = $lastDetailsText.Contains($ApiUrl)
  $sawRegisterCallback = $lastDetailsText.Contains("RegisterCapturePayload") -or $lastDetailsText.Contains("Maestro registered the captured invoice batch payload")
  $sawStageAdvance = [bool]$lastStage -and $lastStage -ne "Capture Intake"

  if ($sawFreshTunnelInCaseStart -and $sawRegisterCallback -and $sawStageAdvance) {
    break
  }

  Start-Sleep -Seconds 5
}

if (-not $sawFreshTunnelInCaseStart) {
  throw "The batch record did not show the fresh API tunnel in Maestro start details within $WaitSeconds seconds. Last details: $lastDetailsText"
}

if (-not $sawRegisterCallback) {
  throw "Maestro was started with the fresh tunnel, but no RegisterCapturePayload callback was observed within $WaitSeconds seconds. Batch: $batchId"
}

if (-not $sawStageAdvance) {
  throw "Maestro registered the capture but did not advance beyond Capture Intake within $WaitSeconds seconds. Last stage: $lastStage. Batch: $batchId"
}

Write-Host "[OK] Maestro start details used fresh API tunnel: $ApiUrl"
Write-Host "[OK] RegisterCapturePayload callback reached the backend."
Write-Host "[OK] Current Maestro stage: $lastStage"
Write-Host "Demo test batch: $batchId"
