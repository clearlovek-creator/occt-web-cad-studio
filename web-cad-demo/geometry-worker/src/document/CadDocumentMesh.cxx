#include "CadDocument.hxx"
#include <new>
#include "CadError.hxx"
#include "../mesh/MeshPreparation.hxx"
#include "../mesh/MeshDiagnostics.hxx"
#include "../mesh/DiscreteSurfaceExport.hxx"
#include "../presentation/ShapeSerializer.hxx"
#include "../protocol/Json.hxx"
#include <BRepTools.hxx>
#include <filesystem>
#include <fstream>
#include <cmath>

namespace occweb
{
std::string CadDocument::ExportDiscreteSurface(const std::string& requestId,const JsonValue& parameters) const
{
  std::vector<MeshPreparationBody> inputs;
  for(const auto& [id,body]:myBodies){
    const auto identity=myEntityIdentities.find(id);
    if(identity==myEntityIdentities.end())throw CadError("SURFACE_EXPORT_SOURCE_INVALID","Body identity is missing.");
    MeshPreparationBody input{id,body.Name,body.Kind,identity->second.Body,identity->second.Topology,body.TopologyRevision,body.Shape,{}};
    ShapeSerializer topology(body.Shape,body.TopologyRevision,id);
    for(int i=1;i<=topology.Faces().Extent();i++)input.FaceIds.push_back(topology.FaceIdAt(i));
    inputs.push_back(std::move(input));
  }
  auto response=JsonParser(responsePrefix(requestId)+'}').Parse();
  response.ChangeObject()["discreteSurface"]=ExportDiscreteSurfaceSource(inputs,myDocumentId,myRevision,parameters);return JsonSerialize(response);
}
std::string CadDocument::PrepareMeshSnapshot(const std::string& requestId,const std::string& path,
                                           const std::string& manifestPath,const std::string& mode,
                                           bool includePreview,bool deepCheck)
{
  if(myBodies.empty())throw CadError("DOCUMENT_EMPTY","The document has no bodies to mesh.");
  MeshPreparationDiagnostics diagnostics(mode,deepCheck);
  auto response=JsonParser(responsePrefix(requestId)+'}').Parse();
  try
  {
    std::vector<MeshPreparationBody> inputs;
    for(const auto& [id,body]:myBodies)
    {
      const auto identity=myEntityIdentities.find(id);
      if(identity==myEntityIdentities.end())throw CadError("MESH_IDENTITY_MISSING","Body identity is missing.");
      MeshPreparationBody input{id,body.Name,body.Kind,identity->second.Body,identity->second.Topology,body.TopologyRevision,body.Shape,{}};
      ShapeSerializer topology(body.Shape,body.TopologyRevision,id);
      for(int i=1;i<=topology.Faces().Extent();++i)input.FaceIds.push_back(topology.FaceIdAt(i));
      inputs.push_back(std::move(input));
    }
    const auto prepared=PrepareConformalMesh(inputs,myDocumentId,myRevision,mode,&diagnostics);
    const auto brep=std::filesystem::absolute(path).lexically_normal();
    const auto manifest=std::filesystem::absolute(manifestPath).lexically_normal();
    if(brep==manifest)throw CadError("MESH_EXPORT_PATH_INVALID","BREP and manifest must have different paths.");
    std::filesystem::create_directories(brep.parent_path());
    std::filesystem::create_directories(manifest.parent_path());
    // Export before tessellating: display caches must not change the geometry certificate.
    if(!BRepTools::Write(prepared.Shape,brep.string().c_str()))throw CadError("MESH_EXPORT_FAILED","Cannot write prepared BREP snapshot.");
    std::ofstream out(manifest,std::ios::binary|std::ios::trunc);
    out<<prepared.Manifest;out.flush();
    if(!out)throw CadError("MESH_EXPORT_FAILED","Cannot write prepared BREP manifest.");
    auto& data=response.ChangeObject();
    data["path"]=JsonValue(brep.string());data["manifestPath"]=JsonValue(manifest.string());
    data["format"]=JsonValue(std::string("brep"));data["prepared"]=JsonValue(true);
    data["diagnostics"]=JsonParser(diagnostics.Serialize()).Parse();
    if(includePreview)
    {
      const auto& box=data["diagnostics"].At("afterPartition").At("bounds");
      double diagonal=1;
      if(!box.IsNull()){const auto& lo=box.At("min").AsArray();const auto& hi=box.At("max").AsArray();diagonal=std::hypot(std::hypot(hi[0].AsNumber()-lo[0].AsNumber(),hi[1].AsNumber()-lo[1].AsNumber()),hi[2].AsNumber()-lo[2].AsNumber());}
      ShapeSerializationLimits limits;limits.maxTriangles=20000;limits.maxEdges=1000;limits.edgeSamples=12;limits.linearDeflection=std::max(diagonal/500,1e-4);
      data["preview"]=JsonParser(ShapeSerializer(prepared.Shape,myRevision,"preparation-preview",limits).SerializeBody()).Parse();
    }
  }
  catch(const CadError& error)
  {
    diagnostics.Failed(error.Code(),error.what());
    response.ChangeObject()["ok"]=JsonValue(false);response.ChangeObject()["code"]=JsonValue(error.Code());response.ChangeObject()["error"]=JsonValue(std::string(error.what()));response.ChangeObject()["diagnostics"]=JsonParser(diagnostics.Serialize()).Parse();
  }
  catch(const std::bad_alloc&){throw;}
  catch(const std::exception& error)
  {
    diagnostics.Failed("MESH_PREPARATION_FAILED",error.what());
    response.ChangeObject()["ok"]=JsonValue(false);response.ChangeObject()["code"]=JsonValue(std::string("MESH_PREPARATION_FAILED"));response.ChangeObject()["error"]=JsonValue(std::string(error.what()));response.ChangeObject()["diagnostics"]=JsonParser(diagnostics.Serialize()).Parse();
  }
  return JsonSerialize(response);
}
}
