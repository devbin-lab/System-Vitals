# LibreHardwareMonitor auto-setup: download the official GitHub release, unzip, run elevated.
# Triggered by the dashboard "auto install" button, or run manually:
#   powershell -ExecutionPolicy Bypass -File setup_lhm.ps1
# It is a portable run (no system install); admin (UAC) is only needed to read sensors.

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$repo   = 'LibreHardwareMonitor/LibreHardwareMonitor'
$target = Join-Path $PSScriptRoot 'LibreHardwareMonitor'

function Say($m) { Write-Host "[setup-lhm] $m" }

try {
    $exe = Get-ChildItem $target -Recurse -Filter 'LibreHardwareMonitor.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $exe) {
        Say "Querying latest official release: github.com/$repo"
        $rel = Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/releases/latest" -Headers @{ 'User-Agent' = 'pc-monitor' }
        $asset = $rel.assets | Where-Object { $_.name -like '*net472*.zip' } | Select-Object -First 1
        if (-not $asset) { $asset = $rel.assets | Where-Object { $_.name -like '*.zip' } | Select-Object -First 1 }
        if (-not $asset) { throw "No .zip asset found in the release." }

        $zip = Join-Path $env:TEMP ("lhm_" + $asset.name)
        Say ("Downloading: " + $asset.browser_download_url)
        Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $zip -UseBasicParsing
        Say "Extracting to: $target"
        if (Test-Path $target) { Remove-Item $target -Recurse -Force }
        Expand-Archive -Path $zip -DestinationPath $target -Force
        Remove-Item $zip -Force -ErrorAction SilentlyContinue
        $exe = Get-ChildItem $target -Recurse -Filter 'LibreHardwareMonitor.exe' | Select-Object -First 1
    }
    else {
        Say ("Using already-downloaded LHM: " + $exe.FullName)
    }

    if (-not $exe) { throw "LibreHardwareMonitor.exe not found after extract." }

    Say "Launching as administrator (approve the UAC prompt)..."
    Start-Process -FilePath $exe.FullName -Verb RunAs

    Write-Host ""
    Say "Done. Final step in the LHM window:"
    Say "  Options > Remote Web Server > Run   (port 8085),"
    Say "  then refresh the dashboard (http://localhost:8788/) to fill CPU temp / fans."
}
catch {
    Write-Host ""
    Say ("Auto-setup failed: " + $_.Exception.Message)
    Say "Manual: download the zip from https://github.com/$repo/releases/latest , unzip, run as admin."
    exit 1
}
