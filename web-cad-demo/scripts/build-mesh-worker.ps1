param([switch]$NativeTests)
$ErrorActionPreference = "Stop"

$demoRoot = Split-Path -Parent $PSScriptRoot
$workerRoot = Join-Path $demoRoot "mesh-worker"
$buildRoot = if ($env:MESH_WORKER_BUILD_DIR) { [IO.Path]::GetFullPath($env:MESH_WORKER_BUILD_DIR) } else { Join-Path $workerRoot "build-gmsh" }
$gmshRoot = if ($env:GMSH_ROOT) { $env:GMSH_ROOT } else {
  $bundled = Join-Path $demoRoot "..\gmsh-sdk"
  if (Test-Path -LiteralPath (Join-Path $bundled 'include\gmsh.h')) { $bundled }
  elseif (Test-Path -LiteralPath 'C:\msys64\ucrt64\include\gmsh.h') { 'C:\msys64\ucrt64' }
  else { $bundled }
}
$cmake = "C:\Program Files\Microsoft Visual Studio\2022\Community\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe"
$gcc = "C:\msys64\ucrt64\bin\gcc.exe"
$gxx = "C:\msys64\ucrt64\bin\g++.exe"
$ninja = "C:\msys64\ucrt64\bin\ninja.exe"

if (-not (Test-Path -LiteralPath $gmshRoot)) {
  throw "Gmsh SDK not found. Set GMSH_ROOT to an extracted Gmsh SDK directory."
}

$env:PATH = "C:\msys64\ucrt64\bin;C:\msys64\usr\bin;" + $env:PATH
$gmshInclude = Join-Path $gmshRoot "include"
$gmshLibrary = Join-Path $gmshRoot "lib\libgmsh.dll.a"
if (-not (Test-Path -LiteralPath $gmshLibrary)) { $gmshLibrary = Join-Path $gmshRoot "lib\gmsh.lib" }
if (-not (Test-Path -LiteralPath (Join-Path $gmshInclude "gmsh.h")) -or -not (Test-Path -LiteralPath $gmshLibrary)) {
  throw "Gmsh SDK must contain include\gmsh.h and lib\libgmsh.dll.a or lib\gmsh.lib."
}
[string[]]$testArguments = @()
if ($NativeTests) { $testArguments += '-DMESH_NATIVE_TESTS=ON' }
& $cmake -S $workerRoot -B $buildRoot -G Ninja @testArguments `
  -DCMAKE_BUILD_TYPE=Release `
  "-DGMSH_ROOT=$gmshRoot" `
  "-DGMSH_INCLUDE_DIR=$gmshInclude" `
  "-DGMSH_LIBRARY=$gmshLibrary" `
  "-DGMSH_COPY_RUNTIME_DLLS=OFF" `
  "-DCMAKE_C_COMPILER=$gcc" `
  "-DCMAKE_CXX_COMPILER=$gxx" `
  "-DCMAKE_MAKE_PROGRAM=$ninja"
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

& $cmake --build $buildRoot --parallel 4
exit $LASTEXITCODE
