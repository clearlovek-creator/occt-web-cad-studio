cmake_minimum_required(VERSION 3.20)
project(cad_discrete_surface_worker LANGUAGES CXX)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CAD_DISCRETE_BOOST_INCLUDE "${BOOST_ROOT}" CACHE PATH "Verified Boost header tree")
set(Boost_DIR "${CMAKE_CURRENT_SOURCE_DIR}/cmake/boost-headers")
find_package(CGAL 6.1.2 EXACT REQUIRED)
add_library(cad_discrete_surface_core STATIC src/SurfaceRefinement.cxx src/VolumePartition.cxx)
target_include_directories(cad_discrete_surface_core PUBLIC src ../geometry-worker/src)
target_link_libraries(cad_discrete_surface_core PUBLIC CGAL::CGAL)
add_executable(cad_discrete_surface_worker src/main.cxx
  ../geometry-worker/src/protocol/Json.cxx
  ../geometry-worker/src/runtime/NativeResourceGuard.cxx)
target_link_libraries(cad_discrete_surface_worker PRIVATE cad_discrete_surface_core)
option(DISCRETE_BUILD_COMPATIBILITY_HARNESS "Build the original algorithm regression harness" OFF)
if(DISCRETE_BUILD_COMPATIBILITY_HARNESS)
  add_executable(cad_discrete_surface_research ../experiments/discrete-surface/main.cxx
    ../geometry-worker/src/protocol/Json.cxx
    ../geometry-worker/src/runtime/NativeResourceGuard.cxx)
  target_link_libraries(cad_discrete_surface_research PRIVATE cad_discrete_surface_core)
  add_executable(cad_volume_domain_research ../experiments/volume-domain/main.cxx
    ../geometry-worker/src/protocol/Json.cxx
    ../geometry-worker/src/runtime/NativeResourceGuard.cxx)
  target_link_libraries(cad_volume_domain_research PRIVATE cad_discrete_surface_core)
  if(MINGW)
    target_link_options(cad_discrete_surface_research PRIVATE -static-libgcc -static-libstdc++)
    target_link_options(cad_volume_domain_research PRIVATE -static-libgcc -static-libstdc++)
  endif()
endif()
if(MINGW)
  target_link_options(cad_discrete_surface_worker PRIVATE -static-libgcc -static-libstdc++)
endif()
