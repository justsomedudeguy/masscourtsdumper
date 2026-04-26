# Launch Chrome with Remote Debugging Port enabled for dumper.js
$ChromePath = "C:\Users\Grisha\AppData\Local\ms-playwright\chromium-1200\chrome-win64\chrome.exe"
$Port = 9222
$ProfileDir = "$env:USERPROFILE\chrome_dumper_profile"

# Robust cleanup of any existing chrome processes on this port
Write-Host "Cleaning up existing Chrome processes..." -ForegroundColor Gray
Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe' AND CommandLine LIKE '%remote-debugging-port=$Port%'" | Invoke-CimMethod -MethodName Terminate -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1

if (-not (Test-Path $ChromePath)) {
    Write-Error "Chrome executable not found at: $ChromePath"
    exit 1
}

if (-not (Test-Path $ProfileDir)) {
    New-Item -ItemType Directory -Path $ProfileDir -Force | Out-Null
}

Write-Host "Launching Chrome on port $Port..." -ForegroundColor Cyan
Write-Host "Using profile: $ProfileDir" -ForegroundColor Gray

$ChromeArgs = @(
    "--remote-debugging-port=$Port",
    "--user-data-dir=$ProfileDir",
    "--disable-blink-features=AutomationControlled", # Hides navigator.webdriver
    "--no-first-run",
    "--disable-notifications",
    "--disable-sync",
    "--ignore-certificate-errors",
    "--allow-running-insecure-content",
    "--enable-logging",
    "--v=1"
    # Removed --disable-extensions, --disable-popup-blocking, and --no-sandbox to avoid detection and crashes
)

Start-Process -FilePath $ChromePath -ArgumentList $ChromeArgs
Write-Host "Browser process started. If it disappears, please check if 'chrome_debug.log' exists in $ProfileDir" -ForegroundColor Yellow
