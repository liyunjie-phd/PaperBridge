$ErrorActionPreference = "Stop"
$appRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $appRoot
$port = 4317
$url = "http://127.0.0.1:$port"

$listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($listener) {
    Start-Process $url
    exit 0
}

if (-not (Test-Path "node_modules")) {
    npm install
}

$stdout = Join-Path $appRoot "server.out.log"
$stderr = Join-Path $appRoot "server.err.log"
Start-Process -FilePath "node" -ArgumentList "server.js" -WorkingDirectory $appRoot -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr

for ($attempt = 0; $attempt -lt 30; $attempt++) {
    Start-Sleep -Milliseconds 500
    try {
        Invoke-WebRequest -Uri "$url/api/bootstrap" -UseBasicParsing -TimeoutSec 2 | Out-Null
        Start-Process $url
        exit 0
    } catch {
        # Continue until the local service is ready.
    }
}

throw "PaperBridge did not start. Check server.err.log."
