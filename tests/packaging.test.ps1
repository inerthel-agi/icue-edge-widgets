$ErrorActionPreference = "Stop"
$repo = Split-Path $PSScriptRoot -Parent
$fixture = Join-Path $env:TEMP ("icue-package-test-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $fixture | Out-Null
# widgets\<screen>\<name>, plus what the builder reads.
$widgetDirs = @(Get-ChildItem -LiteralPath (Join-Path $repo "widgets") -Directory | Get-ChildItem -Directory | ForEach-Object { $_.FullName.Substring($repo.Length + 1) })
foreach ($dir in $widgetDirs + @("scripts", "icons", "shared")) {
  $dst = Join-Path $fixture $dir
  New-Item -ItemType Directory -Path $dst | Out-Null
  Get-ChildItem -LiteralPath (Join-Path $repo $dir) -File | Where-Object { $_.Extension -in @(".js", ".css", ".html", ".ps1", ".svg", ".woff2") } | Copy-Item -Destination $dst
}
Copy-Item -LiteralPath (Join-Path $repo "VERSION") -Destination $fixture
$output = Join-Path $fixture "dist\icuewidgets"
New-Item -ItemType Directory -Path $output -Force | Out-Null
$sentinel = Join-Path $output "previous.txt"
[IO.File]::WriteAllText($sentinel, "previous distribution")
$cli = Join-Path $fixture "mock-cli.ps1"
@'
$global:LASTEXITCODE = 0
if ($args[0] -eq "validate" -and (Test-Path -LiteralPath (Join-Path $PSScriptRoot "fail-build"))) {
  $global:LASTEXITCODE = 1
}
'@ | Set-Content -LiteralPath $cli
$builder = Join-Path $fixture "scripts\package-icuewidgets.ps1"

function Assert-True($value, $message) { if (-not $value) { throw $message } }
function Expect-BuildFailure($message) {
  $failed = $false
  try { & $builder -CliPath $cli *> (Join-Path $fixture "last-build.log") } catch { $failed = $true }
  Assert-True $failed $message
  Assert-True ((Get-Content -LiteralPath $sentinel -Raw) -eq "previous distribution") "Previous output was lost"
}

[IO.File]::WriteAllText((Join-Path $fixture "fail-build"), "fail")
Expect-BuildFailure "CLI failure did not stop the build"
Move-Item -LiteralPath (Join-Path $fixture "fail-build") -Destination (Join-Path $fixture "failure-tested")
Write-Output "PASS: CLI failure preserves the previous distribution"

$htmlPath = Join-Path $fixture "widgets\xeneon-edge\weather-now\index.html"
$html = [IO.File]::ReadAllText($htmlPath)
[IO.File]::WriteAllText($htmlPath, $html.Replace('</head>', '<script src="missing.js"></script></head>'))
Expect-BuildFailure "Missing local assets were not rejected"
[IO.File]::WriteAllText($htmlPath, $html)
Write-Output "PASS: missing assets stop promotion"

$heldLock = [IO.File]::Open((Join-Path $fixture "icuewidget-build\package.lock"), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
try { Expect-BuildFailure "A concurrent build was allowed" } finally { $heldLock.Dispose() }
Write-Output "PASS: the build lock rejects concurrent publication"

$global:IcueTestFailPromotion = $true
function Move-Item {
  param([string]$LiteralPath, [string]$Destination)
  if ($global:IcueTestFailPromotion -and (Split-Path $LiteralPath -Leaf) -eq "packages") {
    $global:IcueTestFailPromotion = $false
    throw "Simulated promotion failure"
  }
  Microsoft.PowerShell.Management\Move-Item -LiteralPath $LiteralPath -Destination $Destination
}
Expect-BuildFailure "Promotion failure did not surface"
Write-Output "PASS: failed promotion restores the previous distribution"

& $builder -CliPath $cli *> (Join-Path $fixture "last-build.log")
Assert-True (@(Get-ChildItem -LiteralPath $output -Filter *.icuewidget -File -Recurse).Count -eq 14) "Expected fourteen packages"
$backups = @(Get-ChildItem -LiteralPath (Join-Path $fixture "icuewidget-build") -Directory -Filter 'previous-*')
Assert-True (@($backups | Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'previous.txt') }).Count -gt 0) "Previous distribution was not retained"
Write-Output "PASS: successful promotion publishes fourteen verified packages and keeps the backup"
Write-Output "Fixtures and logs: $fixture"
