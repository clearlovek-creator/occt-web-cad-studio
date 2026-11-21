param(
    [ValidateSet('Start','Status','Stop')][string]$Action = 'Start',
    [ValidateRange(1024,65535)][int]$FrontendPort = 3000,
    [ValidateRange(1024,65535)][int]$GatewayPort = 8788,
    [string]$DataDirectory,
    [string]$RuntimeDirectory,
    [ValidateRange(30,600)][int]$VerificationTimeoutSeconds = 180,
    [switch]$AsJson
)
$ErrorActionPreference = 'Stop'
$env:PATHEXT = '.COM;.EXE;.BAT;.CMD'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
$root = [IO.Path]::GetFullPath($PSScriptRoot)
function Ordinary-Path([string]$Relative) {
    if (-not $Relative -or $Relative -match '(^/|\\|:|(^|/)\.{1,2}(/|$)|//)' ) { throw 'Invalid bundle-relative path.' }
    $current = $root
    foreach ($segment in $Relative.Split('/')) {
        $current = Join-Path $current $segment
        $item = Get-Item -LiteralPath $current -Force -ErrorAction Stop
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Bundle links are not allowed.' }
    }
    return $current
}
$manifestFile = Ordinary-Path 'workbench.json'
if ((Get-Item -LiteralPath $manifestFile).Length -gt 2MB) { throw 'Bundle manifest exceeds its limit.' }
$bundle = Get-Content -LiteralPath $manifestFile -Raw -Encoding UTF8 | ConvertFrom-Json
if ($bundle.format -ne 'web-cad-workbench-bundle' -or $bundle.version -ne 1 -or $bundle.releaseId -notmatch '^workbench-[0-9]{13}-[a-f0-9-]{36}$' -or (Split-Path -Leaf $root) -ne $bundle.releaseId -or $bundle.frontend.releaseId -notmatch '^frontend-[0-9]{13}-[a-f0-9-]{36}$' -or $bundle.backend.releaseId -notmatch '^backend-[0-9]{13}-[a-f0-9-]{36}$') { throw 'Invalid workbench identity.' }
$control = @($bundle.controlFiles)
if ($control.Count -lt 10 -or $control.Count -gt 300) { throw 'Invalid workbench control inventory.' }
$seen = @{}
foreach ($record in $control) {
    if ($record.file -notmatch '^(Start-WebCAD\.ps1|app/package\.json|app/(scripts|gateway|shared)/[A-Za-z0-9_./-]+\.(mjs|ps1))$' -or $seen.ContainsKey($record.file) -or $record.sha256 -notmatch '^[a-f0-9]{64}$') { throw 'Invalid workbench control record.' }
    $seen[$record.file] = $true
    # Stop/Status do not need Node or native DLLs to be intact. They still require
    # the certified PowerShell controller before controlling a registered owner.
    if ($Action -ne 'Start' -and $record.file -notin @('Start-WebCAD.ps1','app/scripts/start-web-cad-demo.ps1')) { continue }
    $file = Ordinary-Path $record.file
    if ((Get-Item -LiteralPath $file).Length -ne $record.bytes -or (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() -ne $record.sha256) { throw "Workbench control changed: $($record.file)" }
}
if (-not $seen.ContainsKey('Start-WebCAD.ps1') -or -not $seen.ContainsKey('app/scripts/start-web-cad-demo.ps1') -or -not $seen.ContainsKey('app/scripts/workbench-bundle-info.mjs')) { throw 'Missing required workbench controller.' }
if (-not $DataDirectory) { $DataDirectory = Join-Path $env:LOCALAPPDATA 'WebCAD\Workspace' }
if (-not [IO.Path]::IsPathRooted($DataDirectory)) { throw 'DataDirectory must be absolute.' }
$data = [IO.Path]::GetFullPath($DataDirectory)
if (-not $RuntimeDirectory) { $RuntimeDirectory = "$data-runtime" }
if (-not [IO.Path]::IsPathRooted($RuntimeDirectory)) { throw 'RuntimeDirectory must be absolute.' }
$runtime = [IO.Path]::GetFullPath($RuntimeDirectory)
foreach ($mutable in @($data,$runtime)) {
    if ($mutable -eq $root -or $mutable.StartsWith($root + [IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) { throw 'User data and service logs must be outside the immutable bundle.' }
    # Do not let a lexical outside path lead back into the immutable bundle (or
    # a different storage owner) through an existing junction/symlink.
    $ancestor = $mutable
    while ($ancestor) {
        if (Test-Path -LiteralPath $ancestor) { if ((Get-Item -LiteralPath $ancestor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'User data and service paths cannot pass through links.' } }
        $parent = Split-Path -Parent $ancestor
        if ($parent -eq $ancestor) { break }; $ancestor = $parent
    }
}
$node = Join-Path $root 'node\node.exe'
if ($Action -eq 'Start') {
    $node = Ordinary-Path 'node/node.exe'
    if ($bundle.node.executable.sha256 -notmatch '^[a-f0-9]{64}$' -or (Get-Item -LiteralPath $node).Length -ne $bundle.node.executable.bytes -or (Get-FileHash -LiteralPath $node -Algorithm SHA256).Hash.ToLowerInvariant() -ne $bundle.node.executable.sha256) { throw 'Bundled Node executable changed; no application code executed.' }
    $env:NODE_OPTIONS = $null; $env:NODE_PATH = $null; $env:NODE_V8_COVERAGE = $null
    $env:PATH = "$(Split-Path -Parent $node);$env:SystemRoot\System32;$env:SystemRoot\System32\WindowsPowerShell\v1.0"
    # Observe the actual process, not an ambient PowerShell LASTEXITCODE. A blank
    # native invocation result must never certify a bundle or masquerade as exit.
    $preflight = New-Object Diagnostics.Process
    $preflight.StartInfo.FileName = $node
    $preflight.StartInfo.Arguments = '"' + (Join-Path $root 'app\scripts\workbench-bundle-info.mjs') + '" "' + $root + '"'
    $preflight.StartInfo.WorkingDirectory = $root
    $preflight.StartInfo.UseShellExecute = $false
    $preflight.StartInfo.CreateNoWindow = $true
    $preflight.StartInfo.WindowStyle = 'Hidden'
    $preflight.StartInfo.RedirectStandardOutput = $true
    $preflight.StartInfo.RedirectStandardError = $true
    $preflight.StartInfo.RedirectStandardInput = $true
    $preflight.StartInfo.StandardOutputEncoding = New-Object Text.UTF8Encoding($false)
    $preflight.StartInfo.StandardErrorEncoding = New-Object Text.UTF8Encoding($false)
    if (-not $preflight.Start()) { throw 'Bundle verification process did not start.' }
    $preflight.StandardInput.Close()
    $proofTask = $preflight.StandardOutput.ReadToEndAsync()
    $errorLine = $preflight.StandardError.ReadLineAsync()
    $diagnostic = ''
    $deadline = [DateTime]::UtcNow.AddSeconds($VerificationTimeoutSeconds)
    while (-not $preflight.WaitForExit(100)) {
        while ($errorLine.IsCompleted) {
            $line = $errorLine.GetAwaiter().GetResult()
            if ($null -eq $line) { break }
            [Console]::Error.WriteLine($line)
            if ($diagnostic.Length -lt 8192) { $diagnostic += $line + "`n" }
            $errorLine = $preflight.StandardError.ReadLineAsync()
        }
        if ([DateTime]::UtcNow -gt $deadline) { throw "Bundle verification exit unconfirmed (PID $($preflight.Id)); no service was started. Preserve the bundle and inspect this process. $diagnostic" }
    }
    $proof = $proofTask.GetAwaiter().GetResult()
    $line = $errorLine.GetAwaiter().GetResult()
    if ($null -ne $line) { $diagnostic += $line + "`n" }
    $diagnostic += $preflight.StandardError.ReadToEnd()
    $exitCode = $preflight.ExitCode
    $preflight.Dispose()
    if ($exitCode -ne 0) { throw "Complete bundle verification failed. Node exit code: $exitCode. $($diagnostic.Substring(0,[Math]::Min(2048,$diagnostic.Length))) No service was started." }
    if ($proof.Length -gt 16384) { throw 'Bundle verification reply exceeds its budget.' }
    $verified = $proof | ConvertFrom-Json
    if (-not $verified.ok -or $verified.releaseId -ne $bundle.releaseId -or $verified.nodeExecutable -ne $node) { throw 'Bundle verification reply differs.' }
    $env:PI_CLI_CWD = $null; $env:PI_CLI_PATH = $null
    $env:AGENT_SKILLS_DIR = Join-Path $data 'agent-skills'
    $env:AGENT_KNOWLEDGE_DIR = Join-Path $data 'agent-knowledge'
}
$arguments = @{Action=$Action; DataDirectory=$data; RuntimeDirectory=$runtime; FrontendPort=$FrontendPort; GatewayPort=$GatewayPort; NodeExecutable=$node; FrontendReleaseRoot=(Join-Path $root 'frontend'); FrontendReleaseId=$bundle.frontend.releaseId; GatewayReleaseRoot=(Join-Path $root 'backend'); GatewayReleaseId=$bundle.backend.releaseId; AsJson=[bool]$AsJson}
& (Join-Path $root 'app\scripts\start-web-cad-demo.ps1') @arguments
