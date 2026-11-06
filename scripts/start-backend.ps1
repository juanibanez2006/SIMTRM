$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$pythonPath = Join-Path $projectRoot '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $pythonPath)) {
    throw 'Cree el entorno: python -m venv .venv; luego instale backend\requirements.txt.'
}
Push-Location (Join-Path $projectRoot 'backend')
try { & $pythonPath -m uvicorn app.main:app --host 127.0.0.1 --port 8000 }
finally { Pop-Location }
