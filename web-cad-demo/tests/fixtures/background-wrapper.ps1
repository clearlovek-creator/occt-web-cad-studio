param([string]$Node, [string]$Launcher, [string]$Workspace, [string]$Target, [string]$StdoutFile, [string]$StderrFile, [string]$ReadyFile, [string]$Nonce)
$ErrorActionPreference = 'Stop'
$result = & $Node $Launcher --cwd $Workspace --target $Target --stdout $StdoutFile --stderr $StderrFile -- $ReadyFile $Nonce 6000
if ($LASTEXITCODE -ne 0) { throw 'Background launch failed' }
[Console]::Out.WriteLine($result)
