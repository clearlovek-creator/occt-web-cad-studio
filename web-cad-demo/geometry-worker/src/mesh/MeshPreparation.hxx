#pragma once
#include <TopoDS_Shape.hxx>
#include <string>
#include <vector>

namespace occweb {
class MeshPreparationDiagnostics;
struct MeshPreparationBody {
  std::string Id,Name,Kind,BodyIdentity,TopologyIdentity;
  int TopologyRevision=0;
  TopoDS_Shape Shape;
  std::vector<std::string> FaceIds;
  std::vector<std::string> EdgeIds;
};
struct MeshPreparationResult {TopoDS_Shape Shape;std::string Manifest;};
MeshPreparationResult PrepareConformalMesh(const std::vector<MeshPreparationBody>& bodies,const std::string& documentId,int revision,const std::string& repairMode,MeshPreparationDiagnostics* diagnostics=nullptr);
}
