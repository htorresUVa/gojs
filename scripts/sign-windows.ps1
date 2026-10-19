param(
  [Parameter(Mandatory = $true)]
  [string]$Path
)

$ErrorActionPreference = "Stop"
$dlib = $env:GOJS_ARTIFACT_SIGNING_DLIB
$metadata = $env:GOJS_ARTIFACT_SIGNING_METADATA

if ([string]::IsNullOrWhiteSpace($dlib) -or [string]::IsNullOrWhiteSpace($metadata)) {
  Write-Host "Windows signing is not configured; leaving $Path unsigned."
  exit 0
}

# The Artifact Signing dlib is x64, so it must be loaded by the x64 signtool.
$signTool = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin\*\x64\signtool.exe" |
  Sort-Object FullName -Descending |
  Select-Object -First 1

if (-not $signTool) {
  throw "signtool.exe was not found in the Windows SDK."
}

# The remote signing and timestamp services fail transiently now and then; one
# hiccup should not throw away a full release build.
for ($attempt = 1; $attempt -le 3; $attempt++) {
  & $signTool.FullName sign `
    /v `
    /fd SHA256 `
    /tr http://timestamp.acs.microsoft.com `
    /td SHA256 `
    /dlib $dlib `
    /dmdf $metadata `
    $Path

  if ($LASTEXITCODE -eq 0) {
    exit 0
  }
  Write-Host "Signing attempt $attempt failed for $Path."
  if ($attempt -lt 3) {
    Start-Sleep -Seconds (5 * $attempt)
  }
}

throw "Signing failed for $Path."
