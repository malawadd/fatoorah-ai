$ErrorActionPreference = "Continue"

$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$CasePlan = Join-Path $Root "uipath\QoyodInvoiceIntakeSolution\QoyodInvoiceIntakeCase\caseplan.json"
$Failures = 0

function Write-Check {
  param(
    [string]$Name,
    [bool]$Ok,
    [string]$Detail = ""
  )

  $mark = if ($Ok) { "OK" } else { "FAIL" }
  Write-Host ("[{0}] {1}{2}" -f $mark, $Name, $(if ($Detail) { " - $Detail" } else { "" }))
  if (-not $Ok) {
    $script:Failures += 1
  }
}

function Invoke-UipJson {
  param([string[]]$CliArgs)

  $output = & uip @CliArgs 2>&1
  $exitCode = $LASTEXITCODE
  $text = ($output | Out-String).Trim()
  $json = $null
  if ($text) {
    try {
      $json = $text | ConvertFrom-Json
    } catch {
      $json = $null
    }
  }

  [pscustomobject]@{
    ExitCode = $exitCode
    Text = $text
    Json = $json
  }
}

function Read-DotEnv {
  param([string]$Path)

  $values = @{}
  if (-not (Test-Path $Path)) {
    return $values
  }

  foreach ($line in Get-Content $Path) {
    $trimmed = $line.Trim()
    if (-not $trimmed -or $trimmed.StartsWith("#") -or -not $trimmed.Contains("=")) {
      continue
    }

    $parts = $trimmed.Split("=", 2)
    $values[$parts[0].Trim()] = $parts[1].Trim().Trim('"').Trim("'")
  }

  return $values
}

function EnvValue {
  param(
    [hashtable]$DotEnv,
    [string]$Name
  )

  $processValue = [Environment]::GetEnvironmentVariable($Name)
  if ($processValue) {
    return $processValue
  }
  return $DotEnv[$Name]
}

Write-Host "Qoyod Invoice Intake Maestro preflight"
Write-Host ("Root: {0}" -f $Root)

$dotEnv = @{}
foreach ($envPath in @((Join-Path $Root "..\.env"), (Join-Path $Root ".env"))) {
  foreach ($entry in (Read-DotEnv $envPath).GetEnumerator()) {
    $dotEnv[$entry.Key] = $entry.Value
  }
}
$requiredEnv = @(
  "PUBLIC_API_BASE_URL",
  "PUBLIC_WEB_APP_URL",
  "CASE_CALLBACK_TOKEN",
  "UIPATH_ENABLED",
  "UIPATH_FOLDER_PATH",
  "UIPATH_START_CASE"
)

foreach ($name in $requiredEnv) {
  $value = EnvValue $dotEnv $name
  $detail = if ($value) { "set" } else { "missing" }
  Write-Check "env $name" ([bool]$value) $detail
}

$startCase = (EnvValue $dotEnv "UIPATH_START_CASE") -eq "true"
$folderPath = EnvValue $dotEnv "UIPATH_FOLDER_PATH"
$caseProcessKey = EnvValue $dotEnv "UIPATH_CASE_PROCESS_KEY"
$caseFolderKey = EnvValue $dotEnv "UIPATH_CASE_FOLDER_KEY"
$caseReleaseKey = EnvValue $dotEnv "UIPATH_CASE_RELEASE_KEY"
$caseValidateInputs = EnvValue $dotEnv "UIPATH_CASE_VALIDATE_INPUTS"
Write-Check "env UIPATH_CASE_PROCESS_KEY" ((-not $startCase) -or [bool]$caseProcessKey) $(if ($caseProcessKey) { "set" } elseif ($startCase) { "missing and live Case start is enabled" } else { "not set; live Case start disabled" })
Write-Check "env UIPATH_CASE_FOLDER_KEY" ((-not $startCase) -or [bool]$caseFolderKey) $(if ($caseFolderKey) { "set" } elseif ($startCase) { "missing and live Case start is enabled" } else { "not set; live Case start disabled" })
Write-Check "env UIPATH_CASE_VALIDATE_INPUTS" ($caseValidateInputs -ne "true") $(if ($caseValidateInputs -eq "true") { "must be false in staging because CLI --validate rejects Case package keys" } else { "disabled or false" })
if ($caseProcessKey -and $folderPath) {
  $caseProcesses = Invoke-UipJson @("or", "processes", "list", "--folder-path", $folderPath, "--output", "json")
  $processKeyMatches = @()
  $uuidKeyMatches = @()
  if ($caseProcesses.ExitCode -eq 0 -and $caseProcesses.Json -and $caseProcesses.Json.Data) {
    $processKeyMatches = @($caseProcesses.Json.Data | Where-Object { $_.ProcessKey -eq $caseProcessKey })
    $uuidKeyMatches = @($caseProcesses.Json.Data | Where-Object { $_.Key -eq $caseProcessKey })
  }

  if ($processKeyMatches.Count -gt 0) {
    $matched = $processKeyMatches[0]
    $releaseDetail = if ($caseReleaseKey) { "release $caseReleaseKey" } else { "release key will auto-resolve to $($matched.Key)" }
    Write-Check "configured Case run key" $true ("found {0} v{1}; {2}" -f $matched.ProcessKey, $matched.ProcessVersion, $releaseDetail)
    if ($caseReleaseKey) {
      Write-Check "configured Case release key" ($matched.Key -eq $caseReleaseKey) $(if ($matched.Key -eq $caseReleaseKey) { "matches process Key UUID" } else { "expected $($matched.Key)" })
    }
  } elseif ($uuidKeyMatches.Count -gt 0) {
    $matched = $uuidKeyMatches[0]
    Write-Check "configured Case run key" $false ("configured value is the process UUID Key; use ProcessKey '{0}' and UIPATH_CASE_RELEASE_KEY '{1}'" -f $matched.ProcessKey, $matched.Key)
  } else {
    Write-Check "configured Case run key" $false $(if ($caseProcesses.Text) { $caseProcesses.Text } else { "not found in folder $folderPath" })
  }
}

$publicUrl = EnvValue $dotEnv "PUBLIC_API_BASE_URL"
if ($publicUrl) {
  $isPublicHttps = $publicUrl -match "^https://" -and $publicUrl -notmatch "localhost|127\.0\.0\.1|192\.168\."
  $detail = if ($isPublicHttps) { "public HTTPS URL available for Maestro callbacks" } else { "local URL; use a tunnel before live Maestro callbacks" }
  Write-Check "PUBLIC_API_BASE_URL reachability shape" $true $detail
}

$publicWebUrl = EnvValue $dotEnv "PUBLIC_WEB_APP_URL"
if ($publicWebUrl) {
  $isPublicWebHttps = $publicWebUrl -match "^https://" -and $publicWebUrl -notmatch "localhost|127\.0\.0\.1|192\.168\."
  $detail = if ($isPublicWebHttps) { "public HTTPS URL available for Action Center review links" } else { "local URL; use the web tunnel before live Action Center review" }
  Write-Check "PUBLIC_WEB_APP_URL reachability shape" $true $detail
}

$login = Invoke-UipJson @("login", "status", "--output", "json")
$loginOk = $login.ExitCode -eq 0 -and $login.Json -and (($login.Json.Result -eq "Success") -or $login.Json.Data)
$loginDetail = if ($login.Json.Data.Organization) { "$($login.Json.Data.Organization) / $($login.Json.Data.Tenant)" } else { $login.Text }
Write-Check "uip login status" $loginOk $loginDetail

$tools = Invoke-UipJson @("tools", "list", "--output", "json")
$toolsText = $tools.Text
$toolNames = @("maestro-tool", "orchestrator-tool", "solution-tool")
foreach ($toolName in $toolNames) {
  Write-Check "uip tool $toolName" ($tools.ExitCode -eq 0 -and $toolsText -match [regex]::Escape($toolName)) $(if ($toolsText -match [regex]::Escape($toolName)) { "installed" } else { "not listed" })
}

$folders = Invoke-UipJson @("or", "folders", "list", "--output", "json")
$folderVisible = $folders.ExitCode -eq 0 -and $folders.Text -match "Finance/InvoiceIntake"
Write-Check "Orchestrator folder Finance/InvoiceIntake" $folderVisible $(if ($folderVisible) { "visible" } else { "not found in folder listing" })

if (Test-Path $CasePlan) {
  $caseValidation = Invoke-UipJson @("maestro", "case", "validate", $CasePlan, "--output", "json")
  $caseValid = $caseValidation.ExitCode -eq 0 -and $caseValidation.Text -match '"Result"\s*:\s*"Success"'
  Write-Check "Maestro Case validation" $caseValid $(if ($caseValid) { "valid" } else { $caseValidation.Text })
} else {
  Write-Check "Maestro Case plan exists" $false $CasePlan
}

if ($Failures -gt 0) {
  Write-Host ("Preflight finished with {0} issue(s)." -f $Failures)
  exit 1
}

Write-Host "Preflight passed."
