param([string]$BuildDirectory, [ValidateSet('geometry','mesh')][string]$RuntimeProfile = 'geometry')
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$occtBin = if ($env:OCCT_BIN) { $env:OCCT_BIN } else { Join-Path (Split-Path -Parent $root) 'install-mingw-ucrt64\win64\gcc\bin' }
if (-not $BuildDirectory) { $BuildDirectory = if ($env:GEOMETRY_WORKER_BUILD_DIR) { $env:GEOMETRY_WORKER_BUILD_DIR } else { Join-Path $root 'geometry-worker\build' } }
$build = [IO.Path]::GetFullPath($BuildDirectory)
if (-not (Test-Path -LiteralPath (Join-Path $build 'CTestTestfile.cmake'))) { throw 'Native test build is missing. Run npm run build:worker first.' }
$ctest = 'C:\Program Files\Microsoft Visual Studio\2022\Community\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\ctest.exe'
if (-not (Test-Path -LiteralPath $ctest)) { $ctest = (Get-Command ctest -ErrorAction Stop).Source }
# Geometry and Gmsh can require different same-named OCCT DLLs. Never prepend
# the geometry SDK for a mesh test; use the corresponding runtime profile.
$mingwBin = if ($env:MINGW_BIN) { $env:MINGW_BIN } else { 'C:\msys64\ucrt64\bin' }
$profileBin = $occtBin
if ($RuntimeProfile -eq 'mesh') {
    if ($env:GMSH_BIN) { $profileBin = $env:GMSH_BIN }
    else {
        $line = Get-Content -LiteralPath (Join-Path $build 'CMakeCache.txt') -Encoding UTF8 | Where-Object { $_ -match '^GMSH_ROOT:[^=]*=' } | Select-Object -Last 1
        # Explicit include/library builds legitimately leave GMSH_ROOT empty.
        # Do not pass that empty cache value to Join-Path.
        $gmshRoot = if ($line) { (($line -split '=',2)[1]).Trim() } else { '' }
        $profileBin = if (-not [string]::IsNullOrWhiteSpace($gmshRoot)) { Join-Path $gmshRoot 'bin' } else { $mingwBin }
    }
}
if (-not (Test-Path -LiteralPath $profileBin -PathType Container)) { throw 'Native test runtime directory is missing.' }
$env:PATH = (@($profileBin, $mingwBin, 'C:\msys64\usr\bin') -join ';') + ';' + $env:PATH
& $ctest --test-dir $build --output-on-failure
exit $LASTEXITCODE
