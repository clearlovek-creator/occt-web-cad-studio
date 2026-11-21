cmake_minimum_required(VERSION 3.20)
project(gmsh_mesh_worker LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

set(GMSH_ROOT "" CACHE PATH "Gmsh SDK or installation root")
set(GMSH_INCLUDE_DIR "" CACHE PATH "Directory containing gmsh.h")
set(GMSH_LIBRARY "" CACHE FILEPATH "Gmsh import/static library")

if(NOT GMSH_INCLUDE_DIR)
  find_path(GMSH_INCLUDE_DIR
    NAMES gmsh.h
    HINTS "${GMSH_ROOT}" "${GMSH_ROOT}/include"
    PATH_SUFFIXES include)
endif()

if(NOT GMSH_LIBRARY)
  find_library(GMSH_LIBRARY
    NAMES gmsh libgmsh
    HINTS "${GMSH_ROOT}" "${GMSH_ROOT}/lib" "${GMSH_ROOT}/bin"
    PATH_SUFFIXES lib bin)
endif()

if(NOT GMSH_INCLUDE_DIR OR NOT GMSH_LIBRARY)
  message(FATAL_ERROR
    "Gmsh SDK was not found. Set -DGMSH_ROOT=<sdk-root>, or set "
    "-DGMSH_INCLUDE_DIR=<dir-containing-gmsh.h> and "
    "-DGMSH_LIBRARY=<gmsh-import-library>.")
endif()

add_subdirectory(src/discrete)
add_executable(gmsh_mesh_worker
  src/main.cxx
  src/MeshQuality.cxx
  src/MeshProvenance.cxx
  src/MeshSizing.cxx
  src/MeshOptimization.cxx
  src/MeshWireStore.cxx
  src/discrete/DiscreteVolumeWorker.cxx
  ../geometry-worker/src/protocol/Json.cxx
  ../geometry-worker/src/runtime/NativeResourceGuard.cxx
)

target_include_directories(gmsh_mesh_worker PRIVATE
  src
  ../geometry-worker/src
  "${GMSH_INCLUDE_DIR}")

target_link_libraries(gmsh_mesh_worker PRIVATE "${GMSH_LIBRARY}" cad_discrete_volume_mesh_core)

option(MESH_NATIVE_TESTS "Build isolated mesh numerical regression tests" OFF)
if(MESH_NATIVE_TESTS)
  enable_testing()
  add_executable(mesh_quality_statistics_test tests/MeshQualityStatistics.cxx src/MeshQuality.cxx ../geometry-worker/src/protocol/Json.cxx)
  target_include_directories(mesh_quality_statistics_test PRIVATE src ../geometry-worker/src "${GMSH_INCLUDE_DIR}")
  target_link_libraries(mesh_quality_statistics_test PRIVATE "${GMSH_LIBRARY}")
  if(MINGW)
    target_link_options(mesh_quality_statistics_test PRIVATE -static-libgcc -static-libstdc++)
  endif()
  add_test(NAME mesh_quality_statistics COMMAND mesh_quality_statistics_test)
  add_executable(mesh_sizing_test tests/MeshSizing.cxx src/MeshSizing.cxx ../geometry-worker/src/protocol/Json.cxx)
  target_include_directories(mesh_sizing_test PRIVATE src ../geometry-worker/src "${GMSH_INCLUDE_DIR}")
  target_link_libraries(mesh_sizing_test PRIVATE "${GMSH_LIBRARY}")
  if(MINGW)
    target_link_options(mesh_sizing_test PRIVATE -static-libgcc -static-libstdc++)
  endif()
  add_test(NAME mesh_sizing COMMAND mesh_sizing_test)
  add_executable(mesh_optimization_test tests/MeshOptimization.cxx src/MeshOptimization.cxx src/MeshQuality.cxx src/MeshSizing.cxx ../geometry-worker/src/protocol/Json.cxx)
  target_include_directories(mesh_optimization_test PRIVATE src ../geometry-worker/src "${GMSH_INCLUDE_DIR}")
  target_link_libraries(mesh_optimization_test PRIVATE "${GMSH_LIBRARY}")
  if(MINGW)
    target_link_options(mesh_optimization_test PRIVATE -static-libgcc -static-libstdc++)
  endif()
  add_test(NAME mesh_optimization COMMAND mesh_optimization_test)
  add_executable(mesh_discrete_quality_test tests/DiscreteVolumeQuality.cxx ../geometry-worker/src/protocol/Json.cxx)
  target_link_libraries(mesh_discrete_quality_test PRIVATE cad_discrete_volume_mesh_core)
  if(MINGW)
    target_link_options(mesh_discrete_quality_test PRIVATE -static-libgcc -static-libstdc++)
  endif()
  add_test(NAME mesh_discrete_quality_controls COMMAND mesh_discrete_quality_test)
endif()

option(MESH_DISCRETE_COMPATIBILITY_HARNESS "Build the shared-core discrete tetrahedral compatibility entry" OFF)
if(MESH_DISCRETE_COMPATIBILITY_HARNESS)
  add_executable(cad_volume_mesh_research ../experiments/volume-mesh/main.cxx ../geometry-worker/src/protocol/Json.cxx ../geometry-worker/src/runtime/NativeResourceGuard.cxx)
  target_link_libraries(cad_volume_mesh_research PRIVATE cad_discrete_volume_mesh_core)
  if(MINGW)
    target_link_options(cad_volume_mesh_research PRIVATE -static-libgcc -static-libstdc++)
  endif()
endif()

option(MESH_WIRE_BENCHMARK "Build the isolated native mesh-wire serialization benchmark" OFF)
if(MESH_WIRE_BENCHMARK)
  add_executable(mesh_wire_benchmark tests/MeshWireBenchmark.cxx src/MeshWireStore.cxx)
  target_include_directories(mesh_wire_benchmark PRIVATE src "${GMSH_INCLUDE_DIR}")
  target_link_libraries(mesh_wire_benchmark PRIVATE "${GMSH_LIBRARY}")
  if(MINGW)
    target_link_options(mesh_wire_benchmark PRIVATE -static-libgcc -static-libstdc++)
  endif()
endif()

if(MINGW)
  target_link_options(gmsh_mesh_worker PRIVATE -static-libgcc -static-libstdc++)
endif()

option(GMSH_COPY_RUNTIME_DLLS "Copy the complete Gmsh runtime directory beside the worker" OFF)
if(WIN32 AND GMSH_COPY_RUNTIME_DLLS)
  set(GMSH_RUNTIME_DIR "${GMSH_ROOT}/bin" CACHE PATH "Directory containing gmsh runtime DLL")
  if(EXISTS "${GMSH_RUNTIME_DIR}")
    add_custom_command(TARGET gmsh_mesh_worker POST_BUILD
      COMMAND ${CMAKE_COMMAND} -E copy_directory
        "${GMSH_RUNTIME_DIR}" "$<TARGET_FILE_DIR:gmsh_mesh_worker>")
  endif()
endif()
