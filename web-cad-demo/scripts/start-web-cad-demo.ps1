param(
    [ValidateSet('Start', 'Status', 'Stop')][string]$Action = 'Start',
    [ValidateSet('All', 'Gateway', 'Frontend')][string]$Service = 'All',
    [ValidateSet('Production', 'Development')][string]$FrontendMode = 'Production',
    [ValidateSet('Production', 'Development')][string]$GatewayMode = 'Production',
    [string]$GatewayReleaseRoot,
    [string]$GatewayReleaseId,
    [string]$FrontendReleaseRoot,
    [string]$FrontendReleaseId,
    [string]$NodeExecutable,
    [ValidateRange(1024, 65535)][int]$FrontendPort = 3000,
    [ValidateRange(1024, 65535)][int]$GatewayPort = 8788,
    [string]$DataDirectory,
    [string]$RuntimeDirectory,
    [ValidateRange(5, 600)][int]$StartupTimeoutSeconds = 120,
    [switch]$Visible,
    [switch]$AsJson
)

$ErrorActionPreference = 'Stop'
# A stripped environment must not turn .exe programs into document associations
# in Windows PowerShell (notably the identity-checked taskkill fallback).
$env:PATHEXT = '.COM;.EXE;.BAT;.CMD'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
$root = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
if (-not $RuntimeDirectory) { $RuntimeDirectory = Join-Path $root 'runtime-logs\services' }
$runtime = [IO.Path]::GetFullPath($RuntimeDirectory)
New-Item -ItemType Directory -Force -Path $runtime | Out-Null
$registryPath = Join-Path $runtime 'services.json'
$lock = $null
$started = @()

function Resolve-NodeExecutable {
    if ($script:resolvedNode) { return $script:resolvedNode }
    if ($NodeExecutable) {
        if (-not [IO.Path]::IsPathRooted($NodeExecutable)) { throw 'NodeExecutable must be an absolute executable path.' }
        $candidate = Get-Item -LiteralPath $NodeExecutable -ErrorAction Stop
        if ($candidate.PSIsContainer -or ($candidate.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $candidate.Extension -ne '.exe') { throw 'NodeExecutable must be an ordinary executable file.' }
        $script:resolvedNode = $candidate.FullName
    } else { $script:resolvedNode = (Get-Command node.exe -ErrorAction Stop).Source }
    return $script:resolvedNode
}

function Quote-CadNodeArgument([string]$Value) {
    $text = New-Object Text.StringBuilder
    $null = $text.Append('"'); $slashes = 0
    foreach ($character in $Value.ToCharArray()) {
        if ($character -eq '\') { $slashes++; continue }
        if ($character -eq '"') { $null = $text.Append(('\' * ($slashes * 2 + 1))); $null = $text.Append('"') }
        else { $null = $text.Append(('\' * $slashes)); $null = $text.Append($character) }
        $slashes = 0
    }
    $null = $text.Append(('\' * ($slashes * 2))); $null = $text.Append('"')
    return $text.ToString()
}

function Invoke-CadNodeCommand([string[]]$Arguments) {
    $process = New-Object Diagnostics.Process
    $process.StartInfo.FileName = Resolve-NodeExecutable
    $process.StartInfo.Arguments = (($Arguments | ForEach-Object { Quote-CadNodeArgument $_ }) -join ' ')
    $process.StartInfo.WorkingDirectory = $root
    $process.StartInfo.UseShellExecute = $false
    $process.StartInfo.CreateNoWindow = $true
    $process.StartInfo.WindowStyle = 'Hidden'
    $process.StartInfo.RedirectStandardInput = $true
    $process.StartInfo.RedirectStandardOutput = $true
    $process.StartInfo.RedirectStandardError = $true
    $process.StartInfo.StandardOutputEncoding = New-Object Text.UTF8Encoding($false)
    $process.StartInfo.StandardErrorEncoding = New-Object Text.UTF8Encoding($false)
    foreach ($key in @('NODE_OPTIONS','NODE_PATH','NODE_V8_COVERAGE')) { $process.StartInfo.EnvironmentVariables.Remove($key) }
    if (-not $process.Start()) { throw 'Node command did not start.' }
    $process.StandardInput.Close()
    $outputTask = $process.StandardOutput.ReadToEndAsync()
    $errorTask = $process.StandardError.ReadToEndAsync()
    if (-not $process.WaitForExit($StartupTimeoutSeconds * 1000)) { throw "Node command exit unconfirmed (PID $($process.Id)); preserve runtime records and inspect the same process." }
    $output = $outputTask.GetAwaiter().GetResult()
    $diagnostic = $errorTask.GetAwaiter().GetResult()
    $code = $process.ExitCode
    $process.Dispose()
    if ($code -ne 0) { throw "Node command failed with exit code $code. $($diagnostic.Substring(0,[Math]::Min(8192,$diagnostic.Length)))" }
    if ($output.Length -gt 16384) { throw 'Node command reply exceeds its budget.' }
    return $output
}

function Read-EnvSetting([string]$Name, [string]$Default) {
    $inherited = [Environment]::GetEnvironmentVariable($Name, 'Process')
    if ($inherited) { return $inherited }
    $envFile = Join-Path $root '.env'
    if (Test-Path -LiteralPath $envFile) {
        $line = Get-Content -LiteralPath $envFile -Encoding UTF8 | Where-Object { $_ -match ('^\s*' + [regex]::Escape($Name) + '\s*=') } | Select-Object -Last 1
        if ($line) {
            $value = ($line -split '=', 2)[1].Trim()
            if ($value.Length -ge 2 -and (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'")))) { return $value.Substring(1, $value.Length - 2) }
            return ($value -replace '\s+#.*$', '').Trim()
        }
    }
    return $Default
}

function Save-Registry {
    $temporary = "$registryPath.tmp-$PID"
    [IO.File]::WriteAllText($temporary, ($script:registry | ConvertTo-Json -Depth 8), (New-Object Text.UTF8Encoding($false)))
    Move-Item -LiteralPath $temporary -Destination $registryPath -Force
}

function Get-OwnedProcess($Entry) {
    $process = Get-Process -Id $Entry.pid -ErrorAction SilentlyContinue
    if (-not $process) { return $null }
    try { $process.Refresh(); if ($process.HasExited) { return $null } } catch { return $null }
    $details = Get-CimInstance Win32_Process -Filter "ProcessId=$($Entry.pid)"
    if (-not $details) { return $null }
    if ($process.StartTime.ToUniversalTime().Ticks.ToString() -ne $Entry.startedTicks -or $process.Path -ne $Entry.executable) { throw "PID $($Entry.pid) no longer belongs to $($Entry.name); refusing to control another process." }
    if (-not $details.CommandLine -or $details.CommandLine.IndexOf($Entry.scriptPath, [StringComparison]::OrdinalIgnoreCase) -lt 0) { throw "Process identity mismatch for $($Entry.name); refusing to stop it." }
    return $process
}

function Test-Ready($Entry) {
    try {
        $response = Invoke-WebRequest -Uri $Entry.healthUrl -TimeoutSec 2 -UseBasicParsing
        if ($response.StatusCode -ne 200) { return $false }
        if ($Entry.name -eq 'gateway') {
            $health = $response.Content | ConvertFrom-Json
            $owned = ($health.ok -eq $true -and $health.gateway -eq $true -and $health.worker -eq $true -and $health.storage.writer.version -eq 1 -and $health.storage.writer.ownerPid -eq $Entry.pid)
            if ($Entry.gatewayMode -eq 'Production') { return ($owned -and $health.backendRelease.mode -eq 'project-code-snapshot' -and $health.backendRelease.releaseId -eq $Entry.releaseId -and $health.backendRelease.manifestSha256 -eq $Entry.manifestSha256) }
            return $owned
        }
        if (-not $response.Content.Contains('OCCT Web Studio')) { return $false }
        if ($Entry.frontendMode -eq 'Production') {
            $health = Invoke-RestMethod -Uri "http://127.0.0.1:$($Entry.port)/__cad/health" -TimeoutSec 2
            return ($health.ok -eq $true -and $health.format -eq 'web-cad-frontend' -and $health.version -eq 1 -and $health.ownerPid -eq $Entry.pid -and $health.mode -eq 'Production' -and $health.releaseId -eq $Entry.releaseId -and $health.gatewayApi -eq $Entry.gatewayApi -and $health.apiMode -eq 'same-origin')
        }
        return $true
    } catch { return $false }
}

function Wait-Ready($Entry) {
    $deadline = [DateTime]::UtcNow.AddSeconds($StartupTimeoutSeconds)
    do {
        if (-not (Get-OwnedProcess $Entry)) {
            $reason = ''
            if (Test-Path -LiteralPath $Entry.stderr) {
                foreach ($line in @(Get-Content -LiteralPath $Entry.stderr -Tail 12 -Encoding UTF8)) {
                    try { $event = $line | ConvertFrom-Json -ErrorAction Stop; if ($event.type -eq 'cad.startup' -and $event.phase -eq 'blocked') { $reason = " $($event.code): $($event.error)" } } catch { }
                }
            }
            throw "$($Entry.name) exited before it became ready.$reason Inspect $($Entry.stderr) and $($Entry.stdout)."
        }
        if ($Entry.name -eq 'gateway') {
            $mismatch = $false
            try {
                $health = Invoke-RestMethod -Uri $Entry.healthUrl -TimeoutSec 2
                if ($health.ok -and $health.gateway -and $health.worker) { $mismatch = (-not $health.storage.writer -or $health.storage.writer.version -ne 1 -or $health.storage.writer.ownerPid -ne $Entry.pid) }
            } catch { }
            if ($mismatch) { throw 'The existing gateway cannot prove matching data-directory ownership. Stop the registered gateway before updating; it was not reused or terminated automatically.' }
        }
        if ($Entry.frontendMode -eq 'Production') {
            $mismatch = $false
            try { $health = Invoke-RestMethod -Uri "http://127.0.0.1:$($Entry.port)/__cad/health" -TimeoutSec 2; if ($health.format -eq 'web-cad-frontend') { $mismatch = ($health.ownerPid -ne $Entry.pid -or $health.releaseId -ne $Entry.releaseId -or $health.gatewayApi -ne $Entry.gatewayApi) } } catch { }
            if ($mismatch) { throw 'Frontend readiness identity does not match its registered owner, release or gateway. Existing service was not restarted.' }
        }
        if (Test-Ready $Entry) { return }
        Start-Sleep -Milliseconds 300
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "$($Entry.name) did not become ready within $StartupTimeoutSeconds seconds. Existing processes were not restarted. Inspect $($Entry.stderr)."
}

function Stop-OwnedService($Entry) {
    if (-not (Get-OwnedProcess $Entry)) { return }
    if ($Entry.name -eq 'gateway' -and $script:registry.dataDirectory) {
        $controlPath = Join-Path $script:registry.dataDirectory '.gateway-control.json'
        $control = $null
        try {
            $candidate = Get-Content -LiteralPath $controlPath -Raw -Encoding UTF8 -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
            $created = [DateTime]::FromFileTimeUtc([long]$candidate.processCreationFileTime).Ticks.ToString()
            if ($candidate.format -eq 'web-cad-shutdown-control' -and $candidate.version -eq 1 -and $candidate.ownerPid -eq $Entry.pid -and $created -eq $Entry.startedTicks -and $candidate.port -eq $Entry.port -and $candidate.token -match '^[a-f0-9]{64}$') { $control = $candidate }
        } catch { }
        if ($control) {
            try { $null = Invoke-RestMethod -Uri "http://127.0.0.1:$($Entry.port)/api/runtime/shutdown" -Method Post -ContentType 'application/json' -Body '{}' -Headers @{'x-cad-shutdown-token'=$control.token} -TimeoutSec 3 -ErrorAction Stop } catch { }
            # An unconfirmed HTTP reply is not permission to resend the stop
            # request or to assume the process exited. Observe this same owner.
            $waitMs = [Math]::Min(45000, [Math]::Max(3000, [double]$control.shutdownBudgetMs + 3000))
            $deadline = [DateTime]::UtcNow.AddMilliseconds($waitMs)
            while ([DateTime]::UtcNow -lt $deadline) {
                if (-not (Get-OwnedProcess $Entry)) {
                    $mode = 'cooperative-exit'
                    try { $report = Get-Content -LiteralPath (Join-Path $script:registry.dataDirectory '.gateway-last-shutdown.json') -Raw -Encoding UTF8 | ConvertFrom-Json; if ($report.ownerInstanceId -eq $control.ownerInstanceId -and $report.ownerPid -eq $Entry.pid) { $mode = if ($report.state -eq 'complete') { 'graceful' } else { 'interrupted' } } } catch { }
                    $Entry | Add-Member -NotePropertyName lastStopMode -NotePropertyValue $mode -Force
                    return
                }
                Start-Sleep -Milliseconds 150
            }
        }
    }
    if (-not (Get-OwnedProcess $Entry)) { return }
    # The identity check above is mandatory: never stop a process just because it owns a port.
    & (Join-Path $env:SystemRoot 'System32\taskkill.exe') /PID $Entry.pid /T /F 2>&1 | Out-Null
    Wait-Process -Id $Entry.pid -Timeout 5 -ErrorAction SilentlyContinue
    if (Get-OwnedProcess $Entry) { throw "Could not stop $($Entry.name)." }
    $Entry | Add-Member -NotePropertyName lastStopMode -NotePropertyValue 'forced' -Force
}

function Start-ManagedService([string]$Name, [string]$ScriptPath, [string[]]$Arguments, [int]$Port, [string]$HealthUrl, [hashtable]$Metadata = @{}) {
    $entry = @($script:registry.services | Where-Object { $_.name -eq $Name }) | Select-Object -First 1
    if ($entry -and (Get-OwnedProcess $entry)) {
        if ($entry.executable -ne (Resolve-NodeExecutable)) { throw 'The running service uses a different Node runtime. Stop it explicitly before switching; it was not restarted.' }
        if ($entry.port -ne $Port) { throw "$Name is already managed on port $($entry.port). Stop the managed services before changing ports." }
        if ($Name -eq 'gateway') {
            $previousMode = if ($entry.gatewayMode) { $entry.gatewayMode } else { 'WorkspaceSource' }
            if ($previousMode -ne $Metadata.gatewayMode -and -not ($previousMode -eq 'WorkspaceSource' -and $Metadata.gatewayMode -eq 'Development')) { throw 'Gateway mode differs from the running service. Workspace source and fixed snapshots cannot be switched implicitly. Stop the registered Gateway explicitly; it was not restarted.' }
            if ($Metadata.gatewayMode -eq 'Production' -and ($entry.releaseId -ne $Metadata.releaseId -or $entry.manifestSha256 -ne $Metadata.manifestSha256)) { throw 'The running Gateway is pinned to a different release. Stop Gateway explicitly before switching; no live files were replaced.' }
        }
        if ($Name -eq 'frontend') {
            $previousMode = if ($entry.frontendMode) { $entry.frontendMode } else { 'Development' }
            if ($previousMode -ne $Metadata.frontendMode) { throw 'Frontend mode differs from the running service. Stop the registered Frontend explicitly before switching Production/Development; it was not restarted.' }
            if ($Metadata.frontendMode -eq 'Production' -and ($entry.releaseId -ne $Metadata.releaseId -or $entry.gatewayApi -ne $Metadata.gatewayApi)) { throw 'The running frontend is pinned to a different release or gateway. Stop Frontend explicitly before switching; no live files were replaced.' }
        }
        Wait-Ready $entry
        return
    }
    $listener = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue
    if ($listener) { throw "Port $Port is occupied by an unmanaged process. It will not be stopped or reused automatically. Use services:status and inspect the existing service." }
    $stamp = [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss-fff')
    $stdout = Join-Path $runtime "$Name-$stamp.out.log"
    $stderr = Join-Path $runtime "$Name-$stamp.err.log"
    $visibility = if ($Visible) { @('--visible') } else { @() }
    $launchOutput = Invoke-CadNodeCommand (@((Join-Path $root 'scripts\launch-background-service.mjs'),'--cwd',$root,'--target',$ScriptPath,'--stdout',$stdout,'--stderr',$stderr,'--profile',$Name) + $visibility + @('--') + $Arguments)
    $launched = $launchOutput | ConvertFrom-Json
    $process = Get-Process -Id $launched.pid -ErrorAction Stop
    $entry = [pscustomobject]@{ name=$Name; pid=$process.Id; startedTicks=$process.StartTime.ToUniversalTime().Ticks.ToString(); executable=$launched.executable; scriptPath=$ScriptPath; port=$Port; healthUrl=$HealthUrl; stdout=$stdout; stderr=$stderr }
    foreach ($key in $Metadata.Keys) { $entry | Add-Member -NotePropertyName $key -NotePropertyValue $Metadata[$key] }
    $script:started += $entry
    $script:registry.services = @($script:registry.services | Where-Object { $_.name -ne $Name }) + @($entry)
    Save-Registry
    Wait-Ready $entry
    $entry | Add-Member -NotePropertyName readyAt -NotePropertyValue ([DateTime]::UtcNow.ToString('o')) -Force
    Save-Registry
}

try {
    try { $lock = [IO.File]::Open((Join-Path $runtime 'services.lock'), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) }
    catch { throw 'Another service management action is running. Wait for it to finish; do not delete the lock file.' }
    $script:registry = if (Test-Path -LiteralPath $registryPath) { Get-Content -LiteralPath $registryPath -Raw -Encoding UTF8 | ConvertFrom-Json } else { [pscustomobject]@{ version=1; root=$root; dataDirectory=$null; services=@() } }
    if ($script:registry.version -ne 1 -or $script:registry.root -ne $root) { throw 'Service registry does not belong to this workspace. No process was changed.' }

    if ($Action -eq 'Stop') {
        foreach ($entry in @($script:registry.services | Where-Object { $Service -eq 'All' -or $_.name -eq $Service.ToLowerInvariant() } | Sort-Object name -Descending)) { Stop-OwnedService $entry }
        Save-Registry
    }
    if ($Action -eq 'Start') {
        if (-not $PSBoundParameters.ContainsKey('GatewayPort')) { $GatewayPort = [int](Read-EnvSetting 'GEOMETRY_PORT' '8788') }
        if ($GatewayPort -lt 1024 -or $GatewayPort -gt 65535) { throw 'GEOMETRY_PORT must be between 1024 and 65535.' }
        if ($FrontendPort -eq $GatewayPort) { throw 'Frontend and gateway ports must be different.' }
        $release = $null
        $backendRelease = $null
        if ($Service -in @('All','Frontend') -and $FrontendMode -eq 'Production') {
            if (-not $FrontendReleaseRoot) { $FrontendReleaseRoot = Join-Path $root '.releases' }
            $FrontendReleaseRoot = if ([IO.Path]::IsPathRooted($FrontendReleaseRoot)) { [IO.Path]::GetFullPath($FrontendReleaseRoot) } else { [IO.Path]::GetFullPath((Join-Path $root $FrontendReleaseRoot)) }
            $releaseArguments = @((Join-Path $root 'scripts\frontend-release-info.mjs'),$FrontendReleaseRoot)
            if ($FrontendReleaseId) { $releaseArguments += $FrontendReleaseId }
            try { $releaseOutput = Invoke-CadNodeCommand $releaseArguments }
            catch { throw "Frontend release validation failed. Existing services were not stopped. $($_.Exception.Message)" }
            $release = $releaseOutput | ConvertFrom-Json
        }
        if ($Service -in @('All','Gateway') -and $GatewayMode -eq 'Production') {
            if (-not $GatewayReleaseRoot) { $GatewayReleaseRoot = Join-Path $root '.backend-releases' }
            $GatewayReleaseRoot = if ([IO.Path]::IsPathRooted($GatewayReleaseRoot)) { [IO.Path]::GetFullPath($GatewayReleaseRoot) } else { [IO.Path]::GetFullPath((Join-Path $root $GatewayReleaseRoot)) }
            $backendArguments = @((Join-Path $root 'scripts\backend-release-info.mjs'),$GatewayReleaseRoot)
            if ($GatewayReleaseId) { $backendArguments += $GatewayReleaseId }
            try { $backendOutput = Invoke-CadNodeCommand $backendArguments }
            catch { throw "Backend release validation failed. Existing services were not stopped. $($_.Exception.Message)" }
            $backendRelease = $backendOutput | ConvertFrom-Json
        }
        foreach ($entry in @($script:registry.services | Where-Object { $_.name -eq 'frontend' })) {
            if ($entry.frontendMode -eq 'Production' -and (Get-OwnedProcess $entry) -and $entry.gatewayApi -ne "http://127.0.0.1:$GatewayPort/api") { throw 'The running frontend uses a different gateway port. Stop Frontend before changing the gateway configuration.' }
        }
        if (-not $DataDirectory) { $DataDirectory = Read-EnvSetting 'GEOMETRY_DATA_DIR' (Join-Path $root '.data') }
        $dataRoot = if ([IO.Path]::IsPathRooted($DataDirectory)) { [IO.Path]::GetFullPath($DataDirectory) } else { [IO.Path]::GetFullPath((Join-Path $root $DataDirectory)) }
        if ($script:registry.dataDirectory -and $script:registry.dataDirectory -ne $dataRoot) {
            foreach ($entry in $script:registry.services) { if (Get-OwnedProcess $entry) { throw 'Data directory cannot change while managed services are running.' } }
        }
        New-Item -ItemType Directory -Force -Path $dataRoot | Out-Null
        $script:registry.dataDirectory = $dataRoot
        # Child process environment only. Never rewrite .env or silently switch persistence to TEMP.
        $env:GEOMETRY_DATA_DIR = $dataRoot
        $env:GEOMETRY_HOST = '127.0.0.1'
        $env:GEOMETRY_PORT = "$GatewayPort"
        $env:GEOMETRY_ALLOW_TEMP_DATA_FALLBACK = 'false'
        $env:WEB_ORIGIN = "http://localhost:$FrontendPort"
        $env:NEXT_PUBLIC_GEOMETRY_API_URL = "http://127.0.0.1:$GatewayPort/api"
        $env:CAD_FRONTEND_TARGET = 'node'
        if ($Service -in @('All','Gateway')) {
            if ($GatewayMode -eq 'Production') { Start-ManagedService 'gateway' (Join-Path $backendRelease.directory 'runtime\scripts\backend-server.mjs') @('--release', $backendRelease.directory, '--workspace', $root) $GatewayPort "http://127.0.0.1:$GatewayPort/api/health" @{ gatewayMode='Production'; releaseId=$backendRelease.releaseId; manifestSha256=$backendRelease.manifestSha256; sourceSha256=$backendRelease.sourceSha256 } }
            else { Start-ManagedService 'gateway' (Join-Path $root 'gateway\server.mjs') @() $GatewayPort "http://127.0.0.1:$GatewayPort/api/health" @{ gatewayMode='Development' } }
        }
        if ($Service -in @('All','Frontend')) {
            if ($FrontendMode -eq 'Production') {
                $entry = Join-Path $release.directory 'runtime\scripts\frontend-server.mjs'
                Start-ManagedService 'frontend' $entry @('--release', $release.directory, '--port', "$FrontendPort", '--gateway-api', "http://127.0.0.1:$GatewayPort/api") $FrontendPort "http://127.0.0.1:$FrontendPort/" @{ frontendMode='Production'; releaseId=$release.releaseId; gatewayApi="http://127.0.0.1:$GatewayPort/api" }
            } else {
                Start-ManagedService 'frontend' (Join-Path $root 'node_modules\vinext\dist\cli.js') @('dev', '--port', "$FrontendPort", '--hostname', '127.0.0.1') $FrontendPort "http://127.0.0.1:$FrontendPort/" @{ frontendMode='Development' }
            }
        }
    }

    $states = @($script:registry.services | ForEach-Object {
        $entry = $_
        $alive = [bool](Get-OwnedProcess $entry)
        $ready = $alive -and (Test-Ready $entry)
        [pscustomobject]@{ Name=$entry.name; Pid=$entry.pid; State=$(if ($ready) { 'ready' } elseif ($alive -and $entry.readyAt) { 'unhealthy' } elseif ($alive) { 'starting' } else { 'stopped' }); Mode=$(if ($entry.name -eq 'frontend') { if ($entry.frontendMode) { $entry.frontendMode } else { 'Development' } } else { if ($entry.gatewayMode) { $entry.gatewayMode } else { 'WorkspaceSource' } }); ReleaseId=$entry.releaseId; GatewayApi=$entry.gatewayApi; LastStopMode=$entry.lastStopMode; Url=$entry.healthUrl; StandardOutput=$entry.stdout; StandardError=$entry.stderr }
    })
    $result = [pscustomobject]@{ Action=$Action; DataDirectory=$script:registry.dataDirectory; RuntimeDirectory=$runtime; Services=$states }
    if ($AsJson) { $result | ConvertTo-Json -Depth 8 -Compress } else { $result | Format-List; $states | Format-Table Name, Pid, State, Url -AutoSize }
} catch {
    # Roll back only processes launched by this action, never a pre-existing service.
    foreach ($entry in @($script:started)) { try { Stop-OwnedService $entry } catch { Write-Warning $_.Exception.Message } }
    throw
} finally {
    if ($lock) { $lock.Dispose() }
}
