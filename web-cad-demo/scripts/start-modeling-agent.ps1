$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location (Join-Path $root "modeling-agent")
$env:PYTHONPATH = "src"
$env:MODEL_AGENT_WORKFLOW_ENGINE = if ($env:MODEL_AGENT_WORKFLOW_ENGINE) { $env:MODEL_AGENT_WORKFLOW_ENGINE } else { "langgraph" }
$env:MODEL_AGENT_GATEWAY_URL = if ($env:MODEL_AGENT_GATEWAY_URL) { $env:MODEL_AGENT_GATEWAY_URL } else { "http://127.0.0.1:8788" }
$defaultAgentDataRoot = Join-Path $env:TEMP "webcad-v1-agent"
New-Item -ItemType Directory -Force -Path $defaultAgentDataRoot | Out-Null
$env:MODEL_AGENT_DATA_PATH = if ($env:MODEL_AGENT_DATA_PATH) { $env:MODEL_AGENT_DATA_PATH } else { Join-Path $defaultAgentDataRoot "agent-state.json" }
$env:MODEL_AGENT_CHECKPOINT_PATH = if ($env:MODEL_AGENT_CHECKPOINT_PATH) { $env:MODEL_AGENT_CHECKPOINT_PATH } else { Join-Path $defaultAgentDataRoot "langgraph-checkpoints.bin" }
$env:MODEL_AGENT_WEB_ORIGINS = if ($env:MODEL_AGENT_WEB_ORIGINS) { $env:MODEL_AGENT_WEB_ORIGINS } else { "http://localhost:3000,http://127.0.0.1:3000" }
$pythonCandidates = @(
    $env:MODEL_AGENT_PYTHON,
    (Join-Path $root ".venv\Scripts\python.exe"),
    (Join-Path $root "modeling-agent\.venv\Scripts\python.exe"),
    (Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe")
)
$pythonExe = $pythonCandidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
if (-not $pythonExe) {
    $pythonCommand = Get-Command python -ErrorAction SilentlyContinue
    if ($pythonCommand -and $pythonCommand.Source -notlike "*WindowsApps*" -and (Test-Path -LiteralPath $pythonCommand.Source)) {
        $pythonExe = $pythonCommand.Source
    }
}
if (-not $pythonExe) {
    throw "No usable Python interpreter found. Install Python 3.12 or 3.13, or set MODEL_AGENT_PYTHON to python.exe."
}
Write-Host "Using Python: $pythonExe"
& $pythonExe -m uvicorn modeling_agent.main:app --host 127.0.0.1 --port 8090
