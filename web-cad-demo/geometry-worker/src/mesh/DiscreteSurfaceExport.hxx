#pragma once
#include "MeshPreparation.hxx"
#include "../protocol/Json.hxx"
#include <cstddef>

namespace occweb
{
struct DiscreteSurfaceExportLimits
{
  static constexpr std::size_t Bodies=512,Faces=10000,Solids=4096,Triangles=20000;
  static constexpr std::size_t InputBytes=8u*1024u*1024u,BundleBytes=16u*1024u*1024u;
};
// Complete original CAD surfaces, not display tessellation, healing, Boolean
// partitioning or closed-volume reconstruction. Meshing occurs on private copies.
JsonValue ExportDiscreteSurfaceSource(const std::vector<MeshPreparationBody>& bodies,
  const std::string& documentId,int revision,const JsonValue& parameters);
std::string DiscreteSurfaceExportCapabilityJson();
}
