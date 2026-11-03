# Copies the shared views into the iCUE widget folders of icue-edge-widgets.
# web/ is the single source; each widget folder only owns its index.html.
param([string]$WidgetsRepo = (Join-Path $PSScriptRoot "..\..\icue-edge-widgets"))
$ErrorActionPreference = "Stop"
$web = Join-Path $PSScriptRoot "..\web"
foreach ($widget in @("claude-usage", "codex-usage")) {
  $dst = Join-Path $WidgetsRepo "widgets\xeneon-edge\$widget"
  if (-not (Test-Path -LiteralPath (Join-Path $dst "index.html"))) { throw "Missing widget folder: $dst" }
  foreach ($file in @("core.js", "widget.css", "widget.js")) {
    Copy-Item -LiteralPath (Join-Path $web $file) -Destination $dst -Force
  }
  Write-Host "Synced $widget"
}
