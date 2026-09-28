param(
  [string]$CliPath = "",
  [string]$Version = ""
)

$ErrorActionPreference = "Stop"

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$runId = [guid]::NewGuid().ToString("N")
$workRoot = Join-Path $root "icuewidget-build\$runId"
$buildRoot = Join-Path $workRoot "widgets"
$stagedOutput = Join-Path $workRoot "packages"
$outRoot = Join-Path $root "dist\icuewidgets"
if (-not $Version) { $Version = (Get-Content -LiteralPath (Join-Path $root "VERSION") -Raw).Trim() }
if ($Version -notmatch "^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$") { throw "Version must be a stable x.y.z version." }

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

function Assert-RepoPath($path) {
  $full = [System.IO.Path]::GetFullPath($path)
  $rootFull = [System.IO.Path]::GetFullPath($root).TrimEnd('\') + '\'
  if (-not $full.StartsWith($rootFull, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to write outside repo: $full"
  }
  $current = $full
  while ($current -and $current -ne $root.Path) {
    if ((Test-Path -LiteralPath $current) -and ((Get-Item -LiteralPath $current -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
      throw "Refusing linked output path: $current"
    }
    $current = Split-Path $current -Parent
  }
}

function Copy-Tree($src, $dst) {
  New-Item -ItemType Directory -Force -Path $dst | Out-Null
  # Widget sources are flat. Referenced assets must pass preflight before packaging.
  Get-ChildItem -LiteralPath $src -File | Where-Object {
    $_.Name -notmatch '^(\.|id_rsa)' -and $_.Extension -in @(".html", ".js", ".css", ".svg", ".png", ".woff2")
  } | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $dst }
}

function Test-StagedWidget($dst) {
  $html = [IO.File]::ReadAllText((Join-Path $dst "index.html"))
  $head = [regex]::Match($html, '(?s)<head>.*?</head>').Value
  [xml]$xml = $head
  if (-not $xml.head.title) { throw "Missing widget title: $dst" }
  $properties = @($xml.SelectNodes('//meta[@name="x-icue-property"]') | ForEach-Object { $_.content })
  foreach ($node in $xml.SelectNodes('//script[@id="x-icue-groups"]')) {
    $groups = $node.InnerText | ConvertFrom-Json
    foreach ($group in $groups) {
      if (-not $group.title) { throw "Group without title: $dst" }
      foreach ($property in $group.properties) {
        if ($properties -notcontains $property) { throw "Unknown property $property in $dst" }
      }
    }
  }
  foreach ($match in [regex]::Matches($html, '(?:src|href)\s*=\s*["'']([^"'']+)["'']')) {
    $asset = [System.Net.WebUtility]::HtmlDecode($match.Groups[1].Value)
    if ($asset -match '^(https://|data:|#)') { continue }
    if ($asset -match '^([a-z]+:|/|\\)') { throw "Unsupported asset path: $asset" }
    $assetPath = [IO.Path]::GetFullPath((Join-Path $dst ($asset -split '[?#]')[0]))
    $prefix = [IO.Path]::GetFullPath($dst).TrimEnd('\') + '\'
    if (-not $assetPath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) -or -not (Test-Path -LiteralPath $assetPath -PathType Leaf)) {
      throw "Missing or escaping widget asset: $asset in $dst"
    }
  }
}

function Test-Archive($source, $output) {
  $zip = [IO.Compression.ZipFile]::OpenRead($output)
  try {
    if ($zip.Entries[0].FullName -ne "index.html") { throw "index.html must be first: $output" }
    $files = @(Get-ChildItem -LiteralPath $source -File -Recurse)
    if ($zip.Entries.Count -ne $files.Count) { throw "Archive file count mismatch: $output" }
    foreach ($entry in $zip.Entries) {
      $file = Join-Path $source $entry.FullName
      $stream = $entry.Open()
      $hash = [Security.Cryptography.SHA256]::Create()
      try { $actual = [BitConverter]::ToString($hash.ComputeHash($stream)).Replace('-', '') }
      finally { $stream.Dispose(); $hash.Dispose() }
      if ($actual -ne (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash) { throw "Archive content mismatch: $file" }
    }
  } finally { $zip.Dispose() }
}

function Update-HtmlForPackage($path, $title, $updateAssetPaths) {
  $html = [System.IO.File]::ReadAllText($path, [System.Text.UTF8Encoding]::new($false))
  $html = [regex]::Replace($html, '(?i)<!doctype\s+html>', '<!DOCTYPE html>', 1)
  if ($updateAssetPaths) {
    foreach ($shared in $sharedFiles) { $html = $html.Replace("$sharedRef$shared", "./$shared") }
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

  # Fonts follow the stylesheets so url("./font.woff2") resolves the same in source and package.
  Get-ChildItem -LiteralPath $dst -File -Filter *.woff2 | ForEach-Object {
    $targetDir = Join-Path $dst "styles"
    New-Item -ItemType Directory -Force -Path $targetDir | Out-Null
    Move-Item -LiteralPath $_.FullName -Destination (Join-Path $targetDir $_.Name) -Force
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
  @{ slug="iss-horizon"; source="widgets/xeneon-edge/iss-horizon"; name="ISS Horizon"; id="com.stealthsrc.isshorizon"; desc="ISS tracking widget for iCUE."; accent="#00c8ff"; label="IS"; icon="iss-horizon"; device="dashboard_lcd"; out="xeneon-edge"; keys=@("ISS Horizon", "Map Style", "Dark", "Satellite", "Day", "Auto") },
  @{ slug="weather-now"; source="widgets/xeneon-edge/weather-now"; name="Weather Now"; id="com.stealthsrc.weathernow"; desc="Current weather dashboard for XENEON EDGE."; accent="#ffb84d"; label="WX"; icon="weather-now"; device="dashboard_lcd"; out="xeneon-edge"; keys=@("Weather Now", "Weather", "City", "Units", "Celsius", "Fahrenheit") },
  @{ slug="github-repo-monitor"; source="widgets/xeneon-edge/github-repo-monitor"; name="GitHub Repo Monitor"; id="com.stealthsrc.githubrepomonitor"; desc="GitHub repository status dashboard for XENEON EDGE."; accent="#a678ff"; label="GH"; icon="github-repo-monitor"; device="dashboard_lcd"; out="xeneon-edge"; keys=@("GitHub Repo Monitor", "GitHub", "Repository", "GitHub Token") },
  @{ slug="windows-media-pump"; source="widgets/pump/windows-media-pump"; name="Windows Media Pump"; id="com.stealthsrc.windowsmediapump"; desc="Now playing from Windows media sessions for Corsair pump LCD. Artwork and progress need iCUE Edge Companion."; accent="#1DB954"; label="WM"; icon="windows-media-pump"; device="pump_lcd"; out="corsair-watercooling"; interactive=$false; plugins=@("widgetbuilder.mediadataprovider:Media:1.0") },
  @{ slug="cooling-sensor-pump"; source="widgets/pump/cooling-sensor-pump"; name="Cooling Sensor Pump"; id="com.stealthsrc.coolingsensorpump"; desc="Automatic cooling sensor display for Corsair pump LCD."; accent="#00c8ff"; label="CS"; icon="cooling-sensor-pump"; device="pump_lcd"; out="corsair-watercooling"; interactive=$false; plugins=@("widgetbuilder.sensorsdataprovider:Sensors:1.0"); keys=@("Automatic sensor", "Manual sensor", "Disable automatic selection to use the manual sensor.") },
  @{ slug="world-clock"; source="widgets/xeneon-edge/world-clock"; name="World Clock"; id="com.stealthsrc.worldclock"; desc="Multi-timezone clock for XENEON EDGE."; accent="#f7f8fb"; label="WC"; icon="world-clock"; device="dashboard_lcd"; out="xeneon-edge"; keys=@("World Clock","Time Zone 1","Time Zone 2","Time Zone 3","Time Zone 4","Format","24h","12h") },
  @{ slug="focus-timer"; source="widgets/xeneon-edge/focus-timer"; name="Focus Timer"; id="com.stealthsrc.focustimer"; desc="Pomodoro focus timer for XENEON EDGE."; accent="#ff6b6b"; label="FT"; icon="focus-timer"; device="dashboard_lcd"; out="xeneon-edge"; keys=@("Focus Timer","Work","Break","Long Break","Cycles") },
  @{ slug="daily-brief"; source="widgets/xeneon-edge/daily-brief"; name="Daily Brief"; id="com.stealthsrc.dailybrief"; desc="Daily brief dashboard for XENEON EDGE."; accent="#00c8ff"; label="DB"; icon="daily-brief"; device="dashboard_lcd"; out="xeneon-edge"; keys=@("Daily Brief","City","Units","Celsius","Fahrenheit","Format","24h","12h") },
  @{ slug="countdowns"; source="widgets/xeneon-edge/countdowns"; name="Countdowns"; id="com.stealthsrc.countdowns"; desc="Countdown tracker for XENEON EDGE."; accent="#ffb84d"; label="CD"; icon="countdowns"; device="dashboard_lcd"; out="xeneon-edge"; keys=@("Countdowns","Event 1 Label","Event 1 Date","Event 1 Color","Event 2 Label","Event 2 Date","Event 2 Color","Event 3 Label","Event 3 Date","Event 3 Color") },
  @{ slug="habit-rings"; source="widgets/xeneon-edge/habit-rings"; name="Habit Rings"; id="com.stealthsrc.habitrings"; desc="Daily habit rings for XENEON EDGE."; accent="#1db954"; label="HR"; icon="habit-rings"; device="dashboard_lcd"; out="xeneon-edge"; keys=@("Habit Rings","Habit 1 Label","Habit 1 Goal","Habit 2 Label","Habit 2 Goal","Habit 3 Label","Habit 3 Goal") },
  @{ slug="claude-usage"; source="widgets/xeneon-edge/claude-usage"; name="Claude Usage"; id="com.stealthsrc.claudeusage"; desc="Claude quotas, tokens and context. Requires iCUE Edge Companion."; accent="#e0a98c"; label="CL"; icon="claude"; device="dashboard_lcd"; out="xeneon-edge"; keys=@("Claude Usage","Widget Personalization","Background","Widget Transparency","Text Color","Accent Color") },
  @{ slug="codex-usage"; source="widgets/xeneon-edge/codex-usage"; name="Codex Usage"; id="com.stealthsrc.codexusage"; desc="Codex quotas, tokens and context. Requires iCUE Edge Companion."; accent="#9cc8ec"; label="CX"; icon="openai"; device="dashboard_lcd"; out="xeneon-edge"; keys=@("Codex Usage","Widget Personalization","Background","Widget Transparency","Text Color","Accent Color") },
  @{ slug="now-playing"; source="widgets/xeneon-edge/now-playing"; name="Now Playing"; id="com.stealthsrc.nowplaying"; desc="Artwork, track and controls of what plays on Windows. Requires iCUE Edge Companion; without it, title and artist from the iCUE Media plugin."; accent="#a8d5ba"; label="NP"; icon="now-playing"; device="dashboard_lcd"; out="xeneon-edge"; plugins=@("widgetbuilder.mediadataprovider:Media:1.0"); keys=@("Now Playing","Widget Personalization","Text Color","Accent Color","Background Color","Background Transparency") },
  @{ slug="spotify"; source="widgets/xeneon-edge/spotify"; name="Spotify"; id="com.stealthsrc.spotify"; desc="Spotify artwork, controls and synced lyrics (LRCLIB). Requires iCUE Edge Companion connected to Spotify Premium; nothing to enter in iCUE."; accent="#1DB954"; label="SP"; icon="spotify"; device="dashboard_lcd"; out="xeneon-edge"; keys=@("Spotify","Theme","Dark","Light","Blur") }
)

Assert-RepoPath $workRoot
Assert-RepoPath $outRoot
New-Item -ItemType Directory -Force -Path (Join-Path $root "icuewidget-build") | Out-Null
$lockPath = Join-Path $root "icuewidget-build\package.lock"
Assert-RepoPath $lockPath
$buildLock = [IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
try {

# Widgets sit in widgets/<screen>/<name>/ and link the files of shared/ with this prefix.
$sharedFiles = @("widget-polish.css", "xeneon-widget.css", "widget-runtime.js")
$sharedRef = "../../../shared/"

foreach ($widget in $widgets) {
  $src = Join-Path $root $widget.source
  $dst = Join-Path $buildRoot $widget.slug
  Copy-Tree $src $dst
  $srcHtml = [System.IO.File]::ReadAllText((Join-Path $src "index.html"))
  foreach ($shared in $sharedFiles) {
    $sharedSrc = Join-Path $root "shared\$shared"
    # Only what the page links is shipped; unlinked copies were dead weight in every package.
    if ((Test-Path $sharedSrc) -and $srcHtml.Contains("$sharedRef$shared")) {
      Copy-Item -LiteralPath $sharedSrc -Destination (Join-Path $dst (Split-Path $shared -Leaf)) -Force
    }
  }

  $bridgeDir = Join-Path $dst "scripts"
  New-Item -ItemType Directory -Force -Path $bridgeDir | Out-Null
  [System.IO.File]::WriteAllText((Join-Path $bridgeDir "icue-events-bridge.js"), "icueEvents={onDataUpdated:function(){},onICUEInitialized:function(){}};`n", [System.Text.UTF8Encoding]::new($false))

  $iconPath = Join-Path $dst "resources\icon.svg"
  $sourceIcon = Join-Path $root "icons\$($widget.icon).svg"
  if (-not (Test-Path $sourceIcon)) { throw "Missing icon icons/$($widget.icon).svg for $($widget.slug)" }
  New-Item -ItemType Directory -Force -Path (Split-Path $iconPath) | Out-Null
  Copy-Item -LiteralPath $sourceIcon -Destination $iconPath -Force
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
    version = $Version
    min_app_version = "5.47"
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

  Test-StagedWidget $dst
  & $CliPath validate $dst
  if ($LASTEXITCODE -ne 0) { throw "Validation failed for $($widget.slug)" }

  $widgetOutRoot = Join-Path $stagedOutput $widget.out
  New-Item -ItemType Directory -Force -Path $widgetOutRoot | Out-Null
  $output = Join-Path $widgetOutRoot ($widget.slug + ".icuewidget")
  & $CliPath package $dst --output $output
  if ($LASTEXITCODE -ne 0) { throw "Packaging failed for $($widget.slug)" }
  New-IcueWidgetArchive $dst $output
  Test-Archive $dst $output
}

# Promotion starts only after every package passes. Preserve the previous set for rollback.
$backup = Join-Path $root "icuewidget-build\previous-$runId"
Assert-RepoPath $backup
Assert-RepoPath $outRoot
Assert-RepoPath $stagedOutput
New-Item -ItemType Directory -Force -Path (Split-Path $outRoot -Parent) | Out-Null
$hadOutput = Test-Path -LiteralPath $outRoot
if ($hadOutput) { Move-Item -LiteralPath $outRoot -Destination $backup }
try {
  Move-Item -LiteralPath $stagedOutput -Destination $outRoot
} catch {
  if ($hadOutput -and -not (Test-Path -LiteralPath $outRoot)) { Move-Item -LiteralPath $backup -Destination $outRoot }
  throw
}
Remove-Item -LiteralPath $workRoot -Recurse -Force -ErrorAction SilentlyContinue
# Keep only the backup made by this run; older ones piled up at every build.
Get-ChildItem -LiteralPath (Join-Path $root "icuewidget-build") -Directory | Where-Object { $_.Name -ne "previous-$runId" -and $_.Name -ne $runId } | ForEach-Object {
  Assert-RepoPath $_.FullName
  Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue
}
Write-Host "Packaged $($widgets.Count) widgets at version $Version into $outRoot"
if ($hadOutput) { Write-Host "Previous packages retained at $backup" }
} finally { $buildLock.Dispose() }
