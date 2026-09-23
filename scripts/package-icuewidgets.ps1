param(
  [string]$CliPath = ""
)

$ErrorActionPreference = "Stop"

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$buildRoot = Join-Path $root ".icuewidget-build"
$outRoot = Join-Path $root "dist\icuewidgets"

if (-not $CliPath) {
  $cmd = Get-Command icuewidget -ErrorAction SilentlyContinue
  if ($cmd) {
    $CliPath = $cmd.Source
  } else {
    $defaultCli = Join-Path $env:LOCALAPPDATA "Programs\iCUEWidgetCLI\bin\icuewidget.exe"
    if (Test-Path $defaultCli) { $CliPath = $defaultCli }
  }
}

if (-not $CliPath -or -not (Test-Path $CliPath)) {
  throw "icuewidget CLI not found. Install WidgetBuilder CLI first."
}

function Reset-Directory($path) {
  $full = [System.IO.Path]::GetFullPath($path)
  $rootFull = [System.IO.Path]::GetFullPath($root)
  if (-not $full.StartsWith($rootFull, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to delete outside repo: $full"
  }
  if (Test-Path $full) {
    Get-ChildItem -LiteralPath $full -Force | Remove-Item -Recurse -Force
  } else {
    New-Item -ItemType Directory -Force -Path $full | Out-Null
  }
}

function Copy-Tree($src, $dst) {
  New-Item -ItemType Directory -Force -Path $dst | Out-Null
  Get-ChildItem -LiteralPath $src -Force | ForEach-Object {
    if ($_.Name -in @(".git", "node_modules", "dist", "build", ".next", "coverage", "vendor", "target")) { return }
    Copy-Item -LiteralPath $_.FullName -Destination $dst -Recurse -Force
  }
}

function Get-IconSvgFragment($icon, $label) {
  switch ($icon) {
    "media" { return @'
<circle cx="32" cy="32" r="17"/>
<path d="M25 38V26l13 6-13 6z" fill="currentColor" stroke="none"/>
<path d="M18 24c-3 5-3 11 0 16M46 24c3 5 3 11 0 16"/>
'@ }
    "iss" { return @'
<path d="M18 36l28-14" fill="none"/>
<path d="M27 27l10 10" fill="none"/>
<rect x="14" y="31" width="11" height="8" rx="2"/>
<rect x="39" y="20" width="11" height="8" rx="2"/>
<rect x="27" y="28" width="10" height="8" rx="2" fill="currentColor" stroke="none"/>
'@ }
    "sensors" { return @'
<path d="M17 42V30"/>
<path d="M28 42V22"/>
<path d="M39 42V27"/>
<path d="M50 42V18"/>
<path d="M14 46h40"/>
'@ }
    "cooling" { return @'
<circle cx="32" cy="32" r="17"/>
<path d="M32 19v26"/>
<path d="M20 32h24"/>
<path d="M24 24l16 16M40 24L24 40"/>
'@ }
    "system" { return @'
<path d="M16 42h32"/>
<path d="M20 36l6-8 7 5 8-13 4 8"/>
<path d="M18 18h28v28H18z"/>
'@ }
    "weather" { return @'
<circle cx="25" cy="25" r="8"/>
<path d="M18 42h27a8 8 0 0 0 0-16 12 12 0 0 0-22 4 7 7 0 0 0-5 12z"/>
'@ }
    "github" { return @'
<circle cx="32" cy="31" r="16"/>
<path d="M25 46c1-5 3-7 7-7s6 2 7 7"/>
<path d="M24 24c-2-4-1-7 0-9 4 1 6 3 8 5 2-2 4-4 8-5 1 2 2 5 0 9"/>
'@ }
    default { return "<text x=`"32`" y=`"39`" text-anchor=`"middle`" font-family=`"Inter, Arial, sans-serif`" font-size=`"19`" font-weight=`"700`" fill=`"currentColor`" stroke=`"none`">$label</text>" }
  }
}

function New-IconSvg($path, $accent, $label, $icon) {
  New-Item -ItemType Directory -Force -Path (Split-Path $path) | Out-Null
  $glyph = Get-IconSvgFragment $icon $label
  $svg = @"
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <circle cx="32" cy="32" r="28" fill="$accent" opacity=".16"/>
  <circle cx="32" cy="32" r="27.5" fill="none" stroke="$accent" stroke-opacity=".58"/>
  <g color="$accent" stroke="currentColor" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round" fill="none">
$glyph
  </g>
</svg>
"@
  [System.IO.File]::WriteAllText($path, $svg, [System.Text.UTF8Encoding]::new($false))
}

function Update-HtmlForPackage($path, $title, $updateAssetPaths) {
  $html = [System.IO.File]::ReadAllText($path, [System.Text.UTF8Encoding]::new($false))
  $html = [regex]::Replace($html, '(?i)<!doctype\s+html>', '<!DOCTYPE html>', 1)
  if ($updateAssetPaths) {
    $html = $html.Replace("../theme-loader.js", "./theme-loader.js")
    $html = $html.Replace("../size-loader.js", "./size-loader.js")
    $html = $html.Replace("../xeneon-edge.css", "./xeneon-edge.css")
    $html = $html.Replace("../xeneon-widget.css", "./xeneon-widget.css")
    $html = $html.Replace("../../widget-polish.css", "./widget-polish.css")
    $html = $html.Replace("../widget-polish.css", "./widget-polish.css")
    $html = [regex]::Replace($html, '<link rel="icon"[^>]*>', '<link rel="icon" type="image/svg+xml" href="resources/icon.svg" />')
  }
  $html = [regex]::Replace($html, '<title>.*?</title>', "", 1)
  $viewportPattern = '<meta\b(?=[^>]*\bname=["'']viewport["''])[^>]*>'
  if ($html -notmatch $viewportPattern) {
    $html = [regex]::Replace($html, '(<meta\s+charset=["''][^"'']+["'']\s*/?>)', "`$1`r`n    <meta name=`"viewport`" content=`"width=device-width, initial-scale=1.0`" />", 1)
  }
  $titleKey = $title.Replace("'", "\'")
  $titleTag = "<title>tr('$titleKey')</title>"
  if ($html -match $viewportPattern) {
    $html = [regex]::Replace($html, "($viewportPattern)", "`$1`r`n    $titleTag", 1)
  } else {
    $html = [regex]::Replace($html, '(<meta\s+charset=["''][^"'']+["'']\s*/?>)', "`$1`r`n    $titleTag", 1)
  }
  if ($html -notmatch '\bicueEvents\s*=') {
    $html = [regex]::Replace($html, '</head>', "    <script src=`"./scripts/icue-events-bridge.js`"></script>`r`n</head>", 1)
  }
  if ($updateAssetPaths -and $html -notmatch '<link rel="icon"') {
    $html = [regex]::Replace($html, '(<title>.*?</title>)', "`$1`r`n    <link rel=`"icon`" type=`"image/svg+xml`" href=`"resources/icon.svg`" />", 1)
  }
  [System.IO.File]::WriteAllText($path, $html, [System.Text.UTF8Encoding]::new($false))
}

function Move-RootAssetsForPackage($dst, $indexPath) {
  $html = [System.IO.File]::ReadAllText($indexPath, [System.Text.UTF8Encoding]::new($false))
  $moves = @()

  Get-ChildItem -LiteralPath $dst -File -Filter *.js | ForEach-Object {
    $targetDir = Join-Path $dst "scripts"
    New-Item -ItemType Directory -Force -Path $targetDir | Out-Null
    $target = Join-Path $targetDir $_.Name
    Move-Item -LiteralPath $_.FullName -Destination $target -Force
    $moves += @{ Name = $_.Name; Prefix = "scripts" }
  }

  Get-ChildItem -LiteralPath $dst -File -Filter *.css | ForEach-Object {
    $targetDir = Join-Path $dst "styles"
    New-Item -ItemType Directory -Force -Path $targetDir | Out-Null
    $target = Join-Path $targetDir $_.Name
    Move-Item -LiteralPath $_.FullName -Destination $target -Force
    $moves += @{ Name = $_.Name; Prefix = "styles" }
  }

  foreach ($move in $moves) {
    $name = [regex]::Escape($move.Name)
    $prefix = $move.Prefix
    $html = [regex]::Replace($html, "(`"|')(\./)?$name(`"|')", "`${1}./$prefix/$($move.Name)`${3}")
  }

  [System.IO.File]::WriteAllText($indexPath, $html, [System.Text.UTF8Encoding]::new($false))
}

function New-TranslationJson($path, $title, $extraKeys = @()) {
  $keys = @($title, "Settings") + $extraKeys | Select-Object -Unique
  $translation = [ordered]@{}
  @("en", "de", "es", "fr", "it", "ja", "ko", "pt", "ru", "zh_CN", "zh_TW", "uk") | ForEach-Object {
    $values = [ordered]@{}
    foreach ($key in $keys) {
      $values[$key] = $key
    }
    $translation[$_] = [ordered]@{
      translation = $values
    }
  }
  $json = $translation | ConvertTo-Json -Depth 5
  [System.IO.File]::WriteAllText($path, $json, [System.Text.UTF8Encoding]::new($false))
}

function New-IcueWidgetArchive($source, $output) {
  Add-Type -AssemblyName System.IO.Compression
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  if (Test-Path $output) { Remove-Item -LiteralPath $output -Force }

  $zip = [System.IO.Compression.ZipFile]::Open($output, [System.IO.Compression.ZipArchiveMode]::Create)
  try {
    $sourceFull = [System.IO.Path]::GetFullPath($source).TrimEnd('\')
    $files = Get-ChildItem -LiteralPath $sourceFull -Recurse -File | ForEach-Object {
      $relative = $_.FullName.Substring($sourceFull.Length + 1).Replace('\', '/')
      [PSCustomObject]@{ File = $_; Relative = $relative }
    }
    $priority = @("index.html", "manifest.json", "translation.json", "resources/icon.svg")
    $orderedFiles = @()
    foreach ($name in $priority) {
      $orderedFiles += $files | Where-Object { $_.Relative -eq $name }
    }
    $orderedFiles += $files | Where-Object { $priority -notcontains $_.Relative } | Sort-Object Relative

    $orderedFiles | ForEach-Object {
      $relative = $_.Relative
      $entry = $zip.CreateEntry($relative, [System.IO.Compression.CompressionLevel]::Optimal)
      $entryStream = $entry.Open()
      $fileStream = [System.IO.File]::OpenRead($_.File.FullName)
      try {
        $fileStream.CopyTo($entryStream)
      } finally {
        $fileStream.Dispose()
        $entryStream.Dispose()
      }
    }
  } finally {
    $zip.Dispose()
  }
}

$widgets = @(
  @{ slug="iss-horizon"; source="iss-horizon"; name="ISS Horizon"; id="com.stealthsrc.isshorizon"; desc="ISS tracking widget for iCUE."; accent="#00c8ff"; label="IS"; icon="iss"; device="dashboard_lcd"; out="xeneon-edge"; keys=@("ISS Horizon", "Map Style", "Dark", "Satellite", "Day", "Auto") },
  @{ slug="weather-now"; source="weather-now"; name="Weather Now"; id="com.stealthsrc.weathernow"; desc="Current weather dashboard for XENEON EDGE."; accent="#ffb84d"; label="WX"; icon="weather"; device="dashboard_lcd"; out="xeneon-edge"; keys=@("Weather Now", "Weather", "City", "Units", "Celsius", "Fahrenheit") },
  @{ slug="github-repo-monitor"; source="github-repo-monitor"; name="GitHub Repo Monitor"; id="com.stealthsrc.githubrepomonitor"; desc="GitHub repository status dashboard for XENEON EDGE."; accent="#a678ff"; label="GH"; icon="github"; device="dashboard_lcd"; out="xeneon-edge"; keys=@("GitHub Repo Monitor", "GitHub", "Repository", "GitHub Token") },
  @{ slug="windows-media-pump"; source="windows-media-pump"; name="Windows Media Pump"; id="com.stealthsrc.windowsmediapump"; desc="Native iCUE media display for Corsair pump LCD."; accent="#1DB954"; label="WM"; icon="media"; device="pump_lcd"; out="corsair-watercooling"; interactive=$false; plugins=@("widgetbuilder.mediadataprovider:Media:1.0") },
  @{ slug="cooling-sensor-pump"; source="cooling-sensor-pump"; name="Cooling Sensor Pump"; id="com.stealthsrc.coolingsensorpump"; desc="Automatic cooling sensor display for Corsair pump LCD."; accent="#00c8ff"; label="CS"; icon="cooling"; device="pump_lcd"; out="corsair-watercooling"; interactive=$false; plugins=@("widgetbuilder.sensorsdataprovider:Sensors:1.0") },
  @{ slug="world-clock"; source="world-clock"; name="World Clock"; id="com.stealthsrc.worldclock"; desc="Multi-timezone clock for XENEON EDGE."; accent="#f7f8fb"; label="WC"; icon="system"; device="dashboard_lcd"; out="xeneon-edge"; keys=@("World Clock","Time Zone 1","Time Zone 2","Time Zone 3","Time Zone 4","Format","24h","12h") },
  @{ slug="focus-timer"; source="focus-timer"; name="Focus Timer"; id="com.stealthsrc.focustimer"; desc="Pomodoro focus timer for XENEON EDGE."; accent="#ff6b6b"; label="FT"; icon="system"; device="dashboard_lcd"; out="xeneon-edge"; keys=@("Focus Timer","Work","Break","Long Break","Cycles") },
  @{ slug="daily-brief"; source="daily-brief"; name="Daily Brief"; id="com.stealthsrc.dailybrief"; desc="Daily brief dashboard for XENEON EDGE."; accent="#00c8ff"; label="DB"; icon="weather"; device="dashboard_lcd"; out="xeneon-edge"; keys=@("Daily Brief","City","Units","Celsius","Fahrenheit","Format","24h","12h") },
  @{ slug="countdowns"; source="countdowns"; name="Countdowns"; id="com.stealthsrc.countdowns"; desc="Countdown tracker for XENEON EDGE."; accent="#ffb84d"; label="CD"; icon="system"; device="dashboard_lcd"; out="xeneon-edge"; keys=@("Countdowns","Event 1 Label","Event 1 Date","Event 1 Color","Event 2 Label","Event 2 Date","Event 2 Color","Event 3 Label","Event 3 Date","Event 3 Color") },
  @{ slug="habit-rings"; source="habit-rings"; name="Habit Rings"; id="com.stealthsrc.habitrings"; desc="Daily habit rings for XENEON EDGE."; accent="#1db954"; label="HR"; icon="system"; device="dashboard_lcd"; out="xeneon-edge"; keys=@("Habit Rings","Habit 1 Label","Habit 1 Goal","Habit 2 Label","Habit 2 Goal","Habit 3 Label","Habit 3 Goal") }
)

Reset-Directory $buildRoot
Reset-Directory $outRoot

$sharedFiles = @("widget-polish.css", "xeneon-widget.css")

foreach ($widget in $widgets) {
  $src = Join-Path $root $widget.source
  $dst = Join-Path $buildRoot $widget.slug
  Copy-Tree $src $dst
  foreach ($shared in $sharedFiles) {
    $sharedSrc = Join-Path $root $shared
    if (Test-Path $sharedSrc) {
      Copy-Item -LiteralPath $sharedSrc -Destination (Join-Path $dst (Split-Path $shared -Leaf)) -Force
    }
  }

  $bridgeDir = Join-Path $dst "scripts"
  New-Item -ItemType Directory -Force -Path $bridgeDir | Out-Null
  [System.IO.File]::WriteAllText((Join-Path $bridgeDir "icue-events-bridge.js"), "icueEvents={onDataUpdated:function(){},onICUEInitialized:function(){}};`n", [System.Text.UTF8Encoding]::new($false))

  $iconPath = Join-Path $dst "resources\icon.svg"
  $sourceIcon = Join-Path $root "svg\$($widget.icon).svg"
  if (Test-Path $sourceIcon) {
    New-Item -ItemType Directory -Force -Path (Split-Path $iconPath) | Out-Null
    Copy-Item -LiteralPath $sourceIcon -Destination $iconPath -Force
  } else {
    New-IconSvg $iconPath $widget.accent $widget.label $widget.icon
  }
  $indexPath = Join-Path $dst "index.html"
  Update-HtmlForPackage $indexPath $widget.name $true
  Move-RootAssetsForPackage $dst $indexPath
  Get-ChildItem -LiteralPath $dst -Recurse -Filter *.html | Where-Object {
    $_.FullName -ne $indexPath
  } | ForEach-Object {
    Remove-Item -LiteralPath $_.FullName -Force
  }

  $manifest = [ordered]@{
    author = "inerthel-agi"
    id = $widget.id
    name = $widget.name
    description = $widget.desc
    version = "1.0.0"
    preview_icon = "resources/icon.svg"
    min_framework_version = "1.0.0"
    os = @(@{ platform = "windows" })
    supported_devices = @([ordered]@{ type = $widget.device })
    interactive = if ($widget.ContainsKey("interactive")) { $widget["interactive"] } else { $true }
  }
  if ($widget.device -eq "dashboard_lcd") {
    $manifest.supported_devices[0].features = @("sensor-screen")
  }
  if ($widget.ContainsKey("plugins")) {
    $manifest.required_plugins = $widget["plugins"]
  }
  $manifestJson = $manifest | ConvertTo-Json -Depth 6
  [System.IO.File]::WriteAllText((Join-Path $dst "manifest.json"), $manifestJson, [System.Text.UTF8Encoding]::new($false))
  $translationKeys = @()
  if ($widget.ContainsKey("keys")) { $translationKeys = $widget["keys"] }
  New-TranslationJson (Join-Path $dst "translation.json") $widget.name $translationKeys

  & $CliPath validate $dst
  if ($LASTEXITCODE -ne 0) { throw "Validation failed for $($widget.slug)" }

  $widgetOutRoot = Join-Path $outRoot $widget.out
  New-Item -ItemType Directory -Force -Path $widgetOutRoot | Out-Null
  $output = Join-Path $widgetOutRoot ($widget.slug + ".icuewidget")
  & $CliPath package $dst --output $output
  if ($LASTEXITCODE -ne 0) { throw "Packaging failed for $($widget.slug)" }
  New-IcueWidgetArchive $dst $output
}

Write-Host "Packaged $($widgets.Count) widgets into $outRoot"
