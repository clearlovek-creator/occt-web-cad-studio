cmake_minimum_required(VERSION 3.20)
project(cad_volume_domain_research LANGUAGES CXX)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CAD_DISCRETE_BOOST_INCLUDE "${BOOST_ROOT}" CACHE PATH "Verified private Boost header tree")
set(Boost_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../../discrete-surface-worker/cmake/boost-headers")
find_package(CGAL 6.1.2 EXACT REQUIRED)
add_executable(cad_volume_domain_research main.cxx ../../discrete-surface-worker/src/VolumePartition.cxx
 ../../discrete-surface-worker/src/SurfaceRefinement.cxx
 ../../geometry-worker/src/protocol/Json.cxx
 ../../geometry-worker/src/runtime/NativeResourceGuard.cxx)
target_include_directories(cad_volume_domain_research PRIVATE ../../geometry-worker/src ../../discrete-surface-worker/src)
target_link_libraries(cad_volume_domain_research PRIVATE CGAL::CGAL)
if(MINGW)
 target_link_options(cad_volume_domain_research PRIVATE -static-libgcc -static-libstdc++)
endif()
