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
    $_.Name -notmatch '^(\.|id_rsa)' -and $_.Extension -in @(".html", ".js", ".css", ".svg", ".png", ".webp", ".woff2")
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
  $keys = @($title, "Settings", "Widget Personalization", "Text Color", "Accent Color", "Background Color", "Background Transparency", "Style", "Instrument", "Apple", "OpenAI", "SpaceX", "Nothing", "Anthropic", "Google", "Terminal", "Corsair", "Aurora", "Paper", "Brutalist", "Synthwave", "Abyss", "Sunset", "Newsprint", "Blueprint", "Forest", "Pastel", "Amber", "HUD", "Bloomberg") + $extraKeys | Select-Object -Unique
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
  @{ slug="claude-usage"; source="widgets/xeneon-edge/claude-usage"; name="Claude Usage"; id="com.stealthsrc.claudeusage"; desc="Claude quotas, tokens and context. Requires iCUE Edge Companion."; accent="#e0a98c"; label="CL"; icon="claude"; device="dashboard_lcd"; out="xeneon-edge"; keys=@("Claude Usage","Widget Personalization","Background Color","Background Transparency","Text Color","Accent Color") },
  @{ slug="codex-usage"; source="widgets/xeneon-edge/codex-usage"; name="Codex Usage"; id="com.stealthsrc.codexusage"; desc="Codex quotas, tokens and context. Requires iCUE Edge Companion."; accent="#9cc8ec"; label="CX"; icon="openai"; device="dashboard_lcd"; out="xeneon-edge"; keys=@("Codex Usage","Widget Personalization","Background Color","Background Transparency","Text Color","Accent Color") },
  @{ slug="now-playing"; source="widgets/xeneon-edge/now-playing"; name="Now Playing"; id="com.stealthsrc.nowplaying"; desc="Artwork, track and controls of what plays on Windows. Requires iCUE Edge Companion; without it, title and artist from the iCUE Media plugin."; accent="#a8d5ba"; label="NP"; icon="now-playing"; device="dashboard_lcd"; out="xeneon-edge"; plugins=@("widgetbuilder.mediadataprovider:Media:1.0"); keys=@("Now Playing","Widget Personalization","Text Color","Accent Color","Background Color","Background Transparency","Cover colors","On","Off","Style","Apple","SpaceX","OpenAI","Nothing","Classic") },
  @{ slug="spotify"; source="widgets/xeneon-edge/spotify"; name="Spotify"; id="com.stealthsrc.spotify"; desc="Spotify artwork, controls and synced lyrics (LRCLIB). Requires iCUE Edge Companion connected to Spotify Premium; nothing to enter in iCUE."; accent="#1DB954"; label="SP"; icon="spotify"; device="dashboard_lcd"; out="xeneon-edge"; keys=@("Spotify","Theme","Dark","Light","Blur") },
  @{ slug="ai-cost"; source="widgets/xeneon-edge/ai-cost"; name="AI Cost"; id="com.stealthsrc.aicost"; desc="Estimated cost of today's Claude and Codex usage. Requires iCUE Edge Companion; the dollar figure is an estimate from token counts, not a bill."; accent="#a8d5ba"; label="AC"; icon="ai-cost"; device="dashboard_lcd"; out="xeneon-edge"; keys=@("AI Cost","Claude price","Codex price","Automatic (from the current model)","Fable 5.x ($10 / $50)","Opus 5.5 ($4 / $20)","Opus 4.5 to 5 ($5 / $25)","Opus 4 / 4.1 ($15 / $75)","Sonnet 5.x ($2 / $10)","Sonnet 4.x ($3 / $15)","Haiku 5.5 ($0.10 / $0.50)","Haiku 4.5 ($1 / $5)","GPT-5.6 Sol ($4 / $20)","GPT-5.6 Terra ($2 / $12)","GPT-5.6 Luna ($0.20 / $1.20)","GPT-5.5 ($5 / $30)","GPT-5.4 ($2.50 / $15)","GPT-5.3 Codex ($1.75 / $14)","GPT-5 ($1.25 / $10)","GPT-5 mini ($0.25 / $2)","Estimate from token counts and the prices chosen here, not a bill.") },
  @{ slug="screen-time"; source="widgets/xeneon-edge/screen-time"; name="Screen Time"; id="com.stealthsrc.screentime"; desc="Time per application today (names only, kept on this PC). Requires iCUE Edge Companion; counting starts when the widget first runs."; accent="#a8d5ba"; label="ST"; icon="screen-time"; device="dashboard_lcd"; out="xeneon-edge"; keys=@("Screen Time","Screen Time counts which application is in front, by name only. It starts when this widget first runs and stays on this PC.") },
  @{ slug="audio-mixer"; source="widgets/xeneon-edge/audio-mixer"; name="Audio Mixer"; id="com.stealthsrc.audiomixer"; desc="Volume, mute and live level of each app playing sound, and of the output device. Requires iCUE Edge Companion."; accent="#a8d5ba"; label="AM"; icon="audio-mixer"; device="dashboard_lcd"; out="xeneon-edge"; keys=@("Audio Mixer") }
  @{ slug="agent-activity"; source="widgets/xeneon-edge/agent-activity"; name="Agent Activity"; id="com.stealthsrc.agentactivity"; desc="What Claude Code is doing now: current step, last tool calls, tokens per minute. Tool and file names only. Requires iCUE Edge Companion."; accent="#e0a98c"; label="AA"; icon="agent-activity"; device="dashboard_lcd"; out="xeneon-edge"; interactive=$false; keys=@("Agent Activity") }
  @{ slug="control-deck"; source="widgets/xeneon-edge/control-deck"; name="Control Deck"; id="com.stealthsrc.controldeck"; desc="Touch buttons for a fixed list of PC actions: microphone, sound, media keys, screenshot, lock, apps. Requires iCUE Edge Companion."; accent="#a8d5ba"; label="CD"; icon="control-deck"; device="dashboard_lcd"; out="xeneon-edge"; keys=@("Control Deck") }
  @{ slug="stocks"; source="widgets/xeneon-edge/stocks"; name="Stocks"; id="com.stealthsrc.stocks"; desc="Watchlist, intraday chart and ticker tape in a market-terminal look. Quotes from Yahoo Finance through iCUE Edge Companion; can be delayed, not investment advice."; accent="#ffa028"; label="ST"; icon="stocks"; device="dashboard_lcd"; out="xeneon-edge"; interactive=$false; keys=@("Stocks","Symbols","Up to 8 Yahoo Finance symbols separated by commas, for example AAPL, MC.PA, ^GSPC, EURUSD=X. The first one gets the chart. Quotes can be delayed; not investment advice.") }
  @{ slug="network-pulse"; source="widgets/xeneon-edge/network-pulse"; name="Network Pulse"; id="com.stealthsrc.networkpulse"; desc="Download and upload rate of this PC with the last minute as a chart, and a ping to a public resolver you choose. Requires iCUE Edge Companion."; accent="#7cc8ff"; label="NP"; icon="network-pulse"; device="dashboard_lcd"; out="xeneon-edge"; interactive=$false; keys=@("Network Pulse","Ping","Units","Off") }
  @{ slug="system-pulse"; source="widgets/xeneon-edge/system-pulse"; name="System Pulse"; id="com.stealthsrc.systempulse"; desc="CPU, GPU, RAM and VRAM load with temperatures and the last minute, from iCUE sensors. No companion needed."; accent="#a8d5ba"; label="SY"; icon="system-pulse"; device="dashboard_lcd"; out="xeneon-edge"; interactive=$false; plugins=@("widgetbuilder.sensorsdataprovider:Sensors:1.0"); keys=@("System Pulse") }
  @{ slug="rig-pet"; source="widgets/xeneon-edge/rig-pet"; name="Rig Pet"; id="com.stealthsrc.rigpet"; desc="A pet that lives with your PC: moods from CPU and GPU heat (iCUE sensors), needs, levels and accessories, a room with the real weather, a ball to throw. Music and Claude Code reactions need iCUE Edge Companion."; accent="#ffb84d"; label="RP"; icon="rig-pet"; device="dashboard_lcd"; out="xeneon-edge"; plugins=@("widgetbuilder.sensorsdataprovider:Sensors:1.0"); keys=@("Rig Pet","Name","Mascot","Bit","Claude","Ghost","Robot","Slime","Clawd","Grace","Sea Lion","Jennie","Claire","Dario","Tom","Patrick","Pepe","Rick","Doge","Mini Elon","Kirby","Clippy","Tux","Frieren","Anya","Miku","Luffy","Goku","Gojo","Umaru","Asuka","Doraemon","Elaina","Violet","Bocchi","Mini Sama","Doro","Guga","Kiki","Usagi","Hachiware","Luo Xiaohei","Your pictures","Preview mode","Image when calm","Image when sleepy","Image when warm","Image when hot","Used only when Mascot is Your pictures. Pictures, GIFs or short videos; a mood without one uses the calm one.","Personality","Calm","Energetic","Grumpy","Accessory","Best earned","None","Warm from","Hot from","Room","Room with the weather","City","Reacts to music and Claude Code","The pet gets warm and hot from the hotter of CPU and GPU. It earns levels and accessories over time; tap it to say hello, swipe to throw it a ball.","The room behind the pet follows the time and the weather of the city (Open-Meteo). Music and Claude Code need iCUE Edge Companion.") }
  @{ slug="flip-clock"; source="widgets/xeneon-edge/flip-clock"; name="Flip Clock"; id="com.stealthsrc.flipclock"; desc="Flip, Nixie or fluorescent clock with optional seconds and date."; accent="#f7f8fb"; label="FC"; icon="flip-clock"; device="dashboard_lcd"; out="xeneon-edge"; interactive=$false; keys=@("Flip Clock","Face","Flip","Nixie","Fluorescent","Format","24h","12h","Seconds","Date") }
  @{ slug="rain-window"; source="widgets/xeneon-edge/rain-window"; name="Rain Window"; id="com.stealthsrc.rainwindow"; desc="A window on the real weather outside: rain on the glass, snow, storm or a clear night, with the time and temperature. Weather from Open-Meteo."; accent="#7cc8ff"; label="RW"; icon="rain-window"; device="dashboard_lcd"; out="xeneon-edge"; interactive=$false; keys=@("Rain Window","City","Units","Celsius","Fahrenheit") }
  @{ slug="racing-gauge-pump"; source="widgets/pump/racing-gauge-pump"; name="Racing Gauge Pump"; id="com.stealthsrc.racinggaugepump"; desc="Racing-style gauge for a cooling sensor on the Corsair pump LCD: temperature, speed in rpm, percent."; accent="#00c8ff"; label="RG"; icon="racing-gauge-pump"; device="pump_lcd"; out="corsair-watercooling"; interactive=$false; plugins=@("widgetbuilder.sensorsdataprovider:Sensors:1.0"); keys=@("Racing Gauge Pump","Automatic sensor","Manual sensor","Disable automatic selection to use the manual sensor.","Design","Classic (Style colours)","Race","Munich","Stuttgart","GR","GT-R","Maranello") }
  @{ slug="fps-gauge-pump"; source="widgets/pump/fps-gauge-pump"; name="FPS Gauge Pump"; id="com.stealthsrc.fpsgaugepump"; desc="Animated FPS gauge on the Corsair pump LCD, from the iCUE FPS sensor, with the frame-generation multiplier you set."; accent="#7cf29a"; label="FP"; icon="fps-gauge-pump"; device="pump_lcd"; out="corsair-watercooling"; interactive=$false; plugins=@("widgetbuilder.sensorsdataprovider:Sensors:1.0"); keys=@("FPS Gauge Pump","FPS","Automatic sensor","Manual sensor","Frame generation","Off (native)","Frame Gen 2x","Multi Frame Gen 3x","Multi Frame Gen 4x","iCUE does not say whether frame generation is on. Dynamic guesses it from the frame rate; choose the setting you use in game for exact figures.","Dynamic (estimated)","Design","Classic (Style colours)","Race","Munich","Stuttgart","GR","GT-R","Maranello") }
)

Assert-RepoPath $workRoot
Assert-RepoPath $outRoot
New-Item -ItemType Directory -Force -Path (Join-Path $root "icuewidget-build") | Out-Null
$lockPath = Join-Path $root "icuewidget-build\package.lock"
Assert-RepoPath $lockPath
$buildLock = [IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
try {

# Widgets sit in widgets/<screen>/<name>/ and link the files of shared/ with this prefix.
$sharedFiles = @("widget-polish.css", "xeneon-widget.css", "widget-styles.css", "widget-runtime.js", "gauge-designs.js", "gauge-designs.css", "gauge-pump.js", "sensor-reader.js")
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
