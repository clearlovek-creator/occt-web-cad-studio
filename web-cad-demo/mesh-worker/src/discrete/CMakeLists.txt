add_library(cad_discrete_volume_mesh_core STATIC
  DiscreteVolumeMesh.cxx PatchedVolumeMesh.cxx QualityControl.cxx MeshSnapshot.cxx GmshSession.cxx LocalCoordinateFrame.cxx MeshCheckpoint.cxx)
target_include_directories(cad_discrete_volume_mesh_core PUBLIC
  "${CMAKE_CURRENT_SOURCE_DIR}" "${CMAKE_CURRENT_SOURCE_DIR}/.."
  "${CMAKE_CURRENT_SOURCE_DIR}/../../../geometry-worker/src" "${GMSH_INCLUDE_DIR}")
target_link_libraries(cad_discrete_volume_mesh_core PUBLIC "${GMSH_LIBRARY}")
