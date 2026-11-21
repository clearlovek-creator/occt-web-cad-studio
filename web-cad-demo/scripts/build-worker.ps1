param([switch]$NativeTests)
$ErrorActionPreference = "Stop"

$demoRoot = Split-Path -Parent $PSScriptRoot
$occtRoot = Split-Path -Parent $demoRoot
$workerRoot = Join-Path $demoRoot "geometry-worker"
$buildRoot = if ($env:GEOMETRY_WORKER_BUILD_DIR) { [IO.Path]::GetFullPath($env:GEOMETRY_WORKER_BUILD_DIR) } else { Join-Path $workerRoot "build" }
$occtInstall = Join-Path $occtRoot "install-mingw-ucrt64"
$cmake = "C:\Program Files\Microsoft Visual Studio\2022\Community\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe"
$gcc = "C:\msys64\ucrt64\bin\gcc.exe"
$gxx = "C:\msys64\ucrt64\bin\g++.exe"
$ninja = "C:\msys64\ucrt64\bin\ninja.exe"

$env:PATH = "C:\msys64\ucrt64\bin;C:\msys64\usr\bin;" + $env:PATH

[string[]]$testArguments = @()
if ($NativeTests) { $testArguments += '-DBUILD_TESTING=ON' }
& $cmake -S $workerRoot -B $buildRoot -G Ninja @testArguments `
  -DCMAKE_BUILD_TYPE=Release `
  "-DCMAKE_PREFIX_PATH=$occtInstall" `
  "-DCMAKE_C_COMPILER=$gcc" `
  "-DCMAKE_CXX_COMPILER=$gxx" `
  "-DCMAKE_MAKE_PROGRAM=$ninja"
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

& $cmake --build $buildRoot --parallel 4
exit $LASTEXITCODE
