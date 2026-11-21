cmake_minimum_required(VERSION 3.20)
project(occt_geometry_worker LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

find_package(OpenCASCADE REQUIRED COMPONENTS
  FoundationClasses ModelingData ModelingAlgorithms Visualization ApplicationFramework DataExchange)

add_library(occt_geometry_core STATIC
  src/protocol/Json.cxx
  src/features/FeatureNode.cxx
  src/features/PrimitiveBuilder.cxx
  src/features/EdgeDetailLimits.cxx
  src/features/BooleanBuilder.cxx
  src/features/LoftBuilder.cxx
  src/features/LoftHoles.cxx
  src/features/SweepBuilder.cxx
  src/exchange/StepImport.cxx
  src/document/CadDocument.cxx
  src/document/CadDocumentIdentity.cxx
  src/document/BodyDisplayMetadata.cxx
  src/document/CadDocumentOperations.cxx
  src/document/CadDocumentBoolean.cxx
  src/document/CadDocumentStep.cxx
  src/document/CadDocumentMesh.cxx
  src/mesh/MeshPreparation.cxx
  src/mesh/MeshDiagnostics.cxx
  src/mesh/DiscreteSurfaceExport.cxx
  src/document/CadDocumentDirect.cxx
  src/document/CadDocumentBasicTransform.cxx
  src/document/CadDocumentRecompute.cxx
  src/document/TopologyHistory.cxx
  src/document/TopologyNaming.cxx
  src/document/SuspendedTopology.cxx
  src/document/ShapeFingerprint.cxx
  src/document/ShapeSpatial.cxx
  src/document/UserPropertyStore.cxx
  src/document/ParameterStore.cxx
  src/document/CoordinateReference.cxx
  src/document/CadDocumentParameters.cxx
  src/document/CadDocumentAdvanced.cxx
  src/document/CadDocumentOffset.cxx
  src/document/CadDocumentDraft.cxx
  src/document/CadDocumentPattern.cxx
  src/document/CadDocumentRevolve.cxx
  src/document/CadDocumentSweep.cxx
  src/document/CadDocumentLoft.cxx
  src/presentation/ShapeSerializer.cxx
  src/presentation/FaceBoundaries.cxx
)
target_link_libraries(occt_geometry_core PUBLIC
  TKernel TKMath TKG2d TKG3d TKGeomBase TKBRep
  TKGeomAlgo TKTopAlgo TKPrim TKBO TKFillet TKOffset TKMesh TKShHealing
  TKCDF TKLCAF TKCAF TKBinL TKBin TKXCAF TKBinXCAF
  TKDE TKXSBase TKDESTEP
)
if(WIN32)
  target_link_libraries(occt_geometry_core PUBLIC bcrypt)
else()
  find_package(OpenSSL REQUIRED COMPONENTS Crypto)
  target_link_libraries(occt_geometry_core PUBLIC OpenSSL::Crypto)
endif()

add_library(native_resource_guard STATIC src/runtime/NativeResourceGuard.cxx)
add_executable(occt_geometry_worker src/main.cxx)
target_link_libraries(occt_geometry_worker PRIVATE occt_geometry_core native_resource_guard)

add_library(occt_snapshot_metadata STATIC src/exchange/SnapshotSources.cxx src/protocol/Json.cxx)
target_link_libraries(occt_snapshot_metadata PUBLIC TKernel TKCDF TKLCAF TKCAF TKBinL TKBin TKXCAF TKBinXCAF)
add_executable(cad_snapshot_source_inspector src/runtime/SnapshotSourceInspector.cxx)
target_link_libraries(cad_snapshot_source_inspector PRIVATE occt_snapshot_metadata)

if(WIN32)
  add_executable(cad_source_file_swap src/runtime/SourceFileSwap.cxx)
  if(MINGW)
    target_link_options(cad_source_file_swap PRIVATE -municode -static -static-libgcc -static-libstdc++)
  endif()
  add_executable(cad_data_directory_lock src/runtime/DataDirectoryLock.cxx)
  if(MINGW)
    target_link_options(cad_data_directory_lock PRIVATE -municode -static -static-libgcc -static-libstdc++)
  endif()
endif()

include(CTest)
if(BUILD_TESTING)
  add_executable(edge_detail_tests tests/edge-detail.cxx)
  target_link_libraries(edge_detail_tests PRIVATE occt_geometry_core)
  add_test(NAME edge_detail COMMAND edge_detail_tests)
  add_executable(native_resource_probe tests/native-resource-probe.cxx)
  target_link_libraries(native_resource_probe PRIVATE native_resource_guard)
  add_test(NAME native_resource_guard COMMAND native_resource_probe)
  if(MINGW)
    target_link_options(native_resource_probe PRIVATE -static-libgcc -static-libstdc++)
  endif()
  add_executable(fingerprint_tests tests/fingerprint.cxx)
  target_link_libraries(fingerprint_tests PRIVATE occt_geometry_core)
  if(WIN32)
    target_link_libraries(fingerprint_tests PRIVATE psapi)
  endif()
  add_test(NAME fingerprint COMMAND fingerprint_tests)
  add_executable(mesh_industrial_corpus_tests tests/mesh-industrial-corpus.cxx)
  target_link_libraries(mesh_industrial_corpus_tests PRIVATE occt_geometry_core)
  add_executable(mesh_solid_self_intersection_tests tests/mesh-solid-self-intersection.cxx)
  target_link_libraries(mesh_solid_self_intersection_tests PRIVATE occt_geometry_core)
  add_test(NAME mesh_solid_self_intersection COMMAND mesh_solid_self_intersection_tests)
  add_executable(loft_holes_tests tests/loft-holes.cxx)
  target_link_libraries(loft_holes_tests PRIVATE occt_geometry_core)
  add_test(NAME loft_holes COMMAND loft_holes_tests)
  add_executable(snapshot_sources_tests tests/snapshot-sources.cxx)
  target_link_libraries(snapshot_sources_tests PRIVATE occt_snapshot_metadata occt_geometry_core)
  add_test(NAME snapshot_sources COMMAND snapshot_sources_tests)
  add_executable(shape_spatial_tests tests/shape-spatial.cxx)
  target_link_libraries(shape_spatial_tests PRIVATE occt_geometry_core)
  add_test(NAME shape_spatial COMMAND shape_spatial_tests)
  add_executable(curve_sweep_tests tests/curve-sweep.cxx)
  target_link_libraries(curve_sweep_tests PRIVATE occt_geometry_core)
  add_test(NAME curve_sweep COMMAND curve_sweep_tests)
  add_executable(suspended_topology_tests tests/suspended-topology.cxx)
  target_link_libraries(suspended_topology_tests PRIVATE occt_geometry_core)
  add_test(NAME suspended_topology COMMAND suspended_topology_tests)
  add_executable(loft_tests tests/loft.cxx)
  target_link_libraries(loft_tests PRIVATE occt_geometry_core)
  add_test(NAME loft COMMAND loft_tests)
  add_executable(generated_topology_tests tests/generated-topology.cxx)
  target_link_libraries(generated_topology_tests PRIVATE occt_geometry_core)
  add_test(NAME generated_topology COMMAND generated_topology_tests)
  add_executable(document_lifecycle_tests tests/document-lifecycle.cxx)
  target_link_libraries(document_lifecycle_tests PRIVATE occt_geometry_core)
  add_test(NAME document_lifecycle COMMAND document_lifecycle_tests)
  add_executable(coordinate_reference_tests tests/coordinate-reference.cxx)
  target_link_libraries(coordinate_reference_tests PRIVATE occt_geometry_core)
  add_test(NAME coordinate_reference COMMAND coordinate_reference_tests)
  add_executable(topology_naming_tests tests/topology-naming.cxx)
  target_link_libraries(topology_naming_tests PRIVATE occt_geometry_core)
  add_test(NAME topology_naming COMMAND topology_naming_tests)
  add_executable(mesh_preparation_tests tests/mesh-preparation.cxx)
  target_link_libraries(mesh_preparation_tests PRIVATE occt_geometry_core)
  add_test(NAME mesh_preparation COMMAND mesh_preparation_tests)
  add_executable(discrete_surface_export_tests tests/discrete-surface-export.cxx)
  target_link_libraries(discrete_surface_export_tests PRIVATE occt_geometry_core)
  add_test(NAME discrete_surface_export COMMAND discrete_surface_export_tests)
  add_executable(mesh_diagnostics_tests tests/mesh-diagnostics.cxx)
  target_link_libraries(mesh_diagnostics_tests PRIVATE occt_geometry_core)
  add_executable(step_import_tests tests/step-import.cxx)
  target_link_libraries(step_import_tests PRIVATE occt_geometry_core)
  add_test(NAME step_import COMMAND step_import_tests)
endif()

if(MINGW)
  target_link_options(occt_geometry_core INTERFACE -static-libgcc -static-libstdc++)
  target_link_options(occt_snapshot_metadata INTERFACE -static-libgcc -static-libstdc++)
endif()
