#include "MeshPreparation.hxx"
#include "MeshDiagnostics.hxx"
#include "../document/CadError.hxx"
#include "../document/ShapeSpatial.hxx"
#include "../protocol/Json.hxx"
#include <BRepBuilderAPI_Copy.hxx>
#include <BRepCheck_Analyzer.hxx>
#include <BRepGProp.hxx>
#include <BRepBndLib.hxx>
#include <BRep_Builder.hxx>
#include <BOPAlgo_Splitter.hxx>
#include <BRepTools_History.hxx>
#include <ShapeFix_Shape.hxx>
#include <ShapeBuild_ReShape.hxx>
#include <TopExp.hxx>
#include <TopExp_Explorer.hxx>
#include <TopoDS_Compound.hxx>
#include <TopTools_IndexedMapOfShape.hxx>
#include <GProp_GProps.hxx>
#include <Bnd_Box.hxx>
#include <algorithm>
#include <iomanip>
#include <map>
#include <set>
#include <sstream>

namespace occweb {
namespace {
struct Source {std::size_t body;int index;TopoDS_Shape shape;bool removed=false;};
struct Repaired {TopoDS_Shape shape;std::vector<std::vector<TopoDS_Shape>> faces,solids;std::vector<bool> removedFaces;};
std::vector<TopoDS_Shape> members(const TopoDS_Shape& shape,TopAbs_ShapeEnum type,const TopTools_IndexedMapOfShape& output) {
  std::vector<TopoDS_Shape> result;if(shape.IsNull())return result;
  TopTools_IndexedMapOfShape map;TopExp::MapShapes(shape,type,map);
  for(int i=1;i<=map.Extent();++i)if(output.Contains(map(i)))result.push_back(map(i));
  return result;
}
std::set<int> descendants(const TopoDS_Shape& shape,TopAbs_ShapeEnum type,const TopTools_IndexedMapOfShape& output,const Handle(BRepTools_History)& history) {
  std::set<int> result;
  const auto append=[&](const TopoDS_Shape& value){for(const auto& child:members(value,type,output))result.insert(output.FindIndex(child)-1);};
  if(!history.IsNull()) {
    for(const auto& value:history->Modified(shape))append(value);
    for(const auto& value:history->Generated(shape))append(value);
    if(history->IsRemoved(shape))return result;
  }
  append(shape);return result;
}
void geometry(std::ostream& out,const TopoDS_Shape& shape,bool volume) {
  GProp_GProps props;if(volume)BRepGProp::VolumeProperties(shape,props);else BRepGProp::SurfaceProperties(shape,props);
  out<<(volume?"\"volume\":" :"\"area\":")<<SpatialNumber(props.Mass())<<",\"centroid\":"<<SpatialPointJson(props.CentreOfMass())<<",\"bounds\":"<<SpatialBoundsJson(shape)<<",\"indexCertificate\":"<<SpatialIndexCertificateJson(shape);
}
void sourceJson(std::ostream& out,const MeshPreparationBody& body,int face) {
  out<<"{\"bodyId\":\""<<JsonEscape(body.Id)<<"\",\"cadFaceId\":\""<<JsonEscape(body.FaceIds.at(face))<<"\",\"bodyIdentity\":\""<<body.BodyIdentity<<"\",\"topologyIdentity\":\""<<body.TopologyIdentity<<"\",\"topologyRevision\":"<<body.TopologyRevision<<'}';
}
}
MeshPreparationResult PrepareConformalMesh(const std::vector<MeshPreparationBody>& bodies,const std::string& documentId,int revision,const std::string& mode,MeshPreparationDiagnostics* diagnostics) {
  if(mode!="strict"&&mode!="conservative"&&mode!="aggressive")throw CadError("MESH_REPAIR_MODE_INVALID","Unknown mesh repair mode.");
  const double tolerance=mode=="aggressive"?1e-6:1e-8;
  std::vector<Repaired> repaired;std::vector<Source> faceSources,solidSources;
  for(std::size_t bodyIndex=0;bodyIndex<bodies.size();++bodyIndex) {
    const auto& body=bodies[bodyIndex];TopTools_IndexedMapOfShape originalFaces,originalSolids;TopExp::MapShapes(body.Shape,TopAbs_FACE,originalFaces);TopExp::MapShapes(body.Shape,TopAbs_SOLID,originalSolids);
    if(originalFaces.Extent()!=static_cast<int>(body.FaceIds.size()))throw CadError("MESH_SOURCE_INVALID","Source face list does not match its geometry.");
    BRepBuilderAPI_Copy copy(body.Shape,true,false);TopoDS_Shape shape=copy.Shape();Handle(ShapeBuild_ReShape) context;
    if(diagnostics){
      MeshPreparationBody copied=body;TopTools_IndexedMapOfShape copiedFaces,originalEdges,copiedEdges;
      TopExp::MapShapes(shape,TopAbs_FACE,copiedFaces);TopExp::MapShapes(shape,TopAbs_EDGE,copiedEdges);TopExp::MapShapes(body.Shape,TopAbs_EDGE,originalEdges);
      copied.FaceIds.assign(copiedFaces.Extent(),"");copied.EdgeIds.assign(copiedEdges.Extent(),"");
      for(int i=1;i<=originalFaces.Extent();++i){const int index=copiedFaces.FindIndex(copy.ModifiedShape(originalFaces(i)));if(!index)throw CadError("MESH_DIAGNOSTIC_SOURCE_LOST","Deep copy lost a source Face.");copied.FaceIds[index-1]=body.FaceIds[i-1];}
      for(int i=1;i<=originalEdges.Extent();++i){const int index=copiedEdges.FindIndex(copy.ModifiedShape(originalEdges(i)));if(!index)throw CadError("MESH_DIAGNOSTIC_SOURCE_LOST","Deep copy lost a source Edge.");copied.EdgeIds[index-1]="edge-"+std::to_string(body.TopologyRevision)+'-'+std::to_string(i);}
      diagnostics->Before(copied,shape);
    }
    // Wires/points must not disappear silently when collecting Solid and Sheet
    // arguments below, including loose subshapes in an otherwise solid Body.
    TopTools_IndexedMapOfShape sourceEdges,sourceVertices,faceEdges,faceVertices;
    TopExp::MapShapes(body.Shape,TopAbs_EDGE,sourceEdges);TopExp::MapShapes(body.Shape,TopAbs_VERTEX,sourceVertices);
    for(int i=1;i<=originalFaces.Extent();++i){TopExp::MapShapes(originalFaces(i),TopAbs_EDGE,faceEdges);TopExp::MapShapes(originalFaces(i),TopAbs_VERTEX,faceVertices);}
    if(originalFaces.IsEmpty()||sourceEdges.Extent()!=faceEdges.Extent()||sourceVertices.Extent()!=faceVertices.Extent())
      throw CadError("MESH_UNSUPPORTED_FREE_TOPOLOGY","The project contains free wires or points. This tetrahedral pipeline currently supports Solids and Sheets only; unsupported geometry was not silently omitted.");
    if(mode!="strict") {ShapeFix_Shape fix(shape);fix.SetPrecision(tolerance);fix.SetMaxTolerance(tolerance);fix.SetMinTolerance(std::min(1e-9,tolerance));fix.Perform();shape=fix.Shape();context=fix.Context();}
    if(diagnostics)diagnostics->After(body,shape);
    if(diagnostics&&diagnostics->HasBlockingRepairErrors())throw CadError("MESH_REPAIR_DIAGNOSTIC_FAILED","Blocking geometric defects remain after repair. Inspect the preparation report.");
    if(shape.IsNull()||!BRepCheck_Analyzer(shape).IsValid())throw CadError("MESH_REPAIR_FAILED","A Body remains invalid after mesh snapshot repair.");
    Repaired entry;entry.shape=shape;TopTools_IndexedMapOfShape faces,solids;TopExp::MapShapes(shape,TopAbs_FACE,faces);TopExp::MapShapes(shape,TopAbs_SOLID,solids);
    for(int i=1;i<=originalFaces.Extent();++i) {
      TopoDS_Shape mapped=copy.ModifiedShape(originalFaces(i));if(!context.IsNull())mapped=context->Apply(mapped);
      entry.faces.push_back(members(mapped,TopAbs_FACE,faces));entry.removedFaces.push_back(mapped.IsNull());
      faceSources.push_back({bodyIndex,i-1,originalFaces(i),mapped.IsNull()});
    }
    for(int i=1;i<=originalSolids.Extent();++i) {
      TopoDS_Shape mapped=copy.ModifiedShape(originalSolids(i));if(!context.IsNull())mapped=context->Apply(mapped);
      auto children=members(mapped,TopAbs_SOLID,solids);
      if(children.empty())throw CadError("MESH_REPAIR_OPEN_VOLUME","No closed volume survived repair of a source solid.");
      entry.solids.push_back(children);solidSources.push_back({bodyIndex,i-1,originalSolids(i)});
    }
    repaired.push_back(std::move(entry));
  }
  // A single imported Body can contain several solids. Split the independent
  // entities, not just Body containers, and retain free Sheet faces as tools.
  TopTools_IndexedMapOfShape arguments;
  for(const auto& body:repaired) {
    TopTools_IndexedMapOfShape bodySolids,solidFaces,bodyFaces;
    TopExp::MapShapes(body.shape,TopAbs_SOLID,bodySolids);TopExp::MapShapes(body.shape,TopAbs_FACE,bodyFaces);
    for(int i=1;i<=bodySolids.Extent();++i){arguments.Add(bodySolids(i));TopExp::MapShapes(bodySolids(i),TopAbs_FACE,solidFaces);}
    for(int i=1;i<=bodyFaces.Extent();++i)if(!solidFaces.Contains(bodyFaces(i)))arguments.Add(bodyFaces(i));
  }
  TopoDS_Shape output;Handle(BRepTools_History) history;
  if(arguments.Extent()>1) {BOPAlgo_Splitter splitter;for(int i=1;i<=arguments.Extent();++i)splitter.AddArgument(arguments(i));splitter.SetNonDestructive(true);splitter.SetToFillHistory(true);splitter.Perform();if(splitter.HasErrors())throw CadError("MESH_PARTITION_FAILED","OCCT could not build a conformal mesh snapshot.");output=splitter.Shape();history=splitter.History();}
  else if(!repaired.empty())output=repaired.front().shape;
  if(output.IsNull()||!BRepCheck_Analyzer(output).IsValid())throw CadError("MESH_PARTITION_INVALID","Conformal mesh snapshot is invalid.");
  TopTools_IndexedMapOfShape solids,faces;TopExp::MapShapes(output,TopAbs_SOLID,solids);
  // Gmsh recursively binds Solid boundaries before free Faces. Use this
  // explicit import order, then certify geometry and incidence at the receiver.
  // TopExp on the mixed root alone can enumerate a free Sheet first.
  for(int i=1;i<=solids.Extent();++i)TopExp::MapShapes(solids(i),TopAbs_FACE,faces);
  TopExp::MapShapes(output,TopAbs_FACE,faces);
  if(solids.IsEmpty())throw CadError("MESH_NO_CLOSED_VOLUME","No closed volume was found after repair; tetrahedral meshing requires a closed solid.");
  std::vector<std::set<int>> solidMap,faceMap;std::vector<std::vector<std::size_t>> solidOwners(solids.Extent()),faceOwners(faces.Extent());
  for(std::size_t i=0;i<solidSources.size();++i){const auto& source=solidSources[i];std::set<int> targets;for(const auto& shape:repaired[source.body].solids[source.index]){const auto found=descendants(shape,TopAbs_SOLID,solids,history);targets.insert(found.begin(),found.end());}if(targets.empty())throw CadError("MESH_SOLID_HISTORY_LOST","A source solid lost its mesh preparation history.");solidMap.push_back(targets);for(int tag:targets)solidOwners[tag].push_back(i);}
  for(std::size_t i=0;i<faceSources.size();++i){auto& source=faceSources[i];std::set<int> targets;bool allRemoved=!repaired[source.body].faces[source.index].empty();for(const auto& shape:repaired[source.body].faces[source.index]){const auto found=descendants(shape,TopAbs_FACE,faces,history);targets.insert(found.begin(),found.end());allRemoved=allRemoved&&!history.IsNull()&&history->IsRemoved(shape);}source.removed=source.removed||(targets.empty()&&allRemoved);faceMap.push_back(targets);for(int tag:targets)faceOwners[tag].push_back(i);}
  for(const auto& owners:solidOwners)if(owners.empty())throw CadError("MESH_SOLID_HISTORY_LOST","A prepared solid has no source Body.");
  std::vector<std::set<int>> adjacent(faces.Extent()),embedded(faces.Extent());
  for(int i=1;i<=solids.Extent();++i)for(TopExp_Explorer explorer(solids(i),TopAbs_FACE);explorer.More();explorer.Next()){
    const auto& shape=explorer.Current();const int face=faces.FindIndex(shape);
    if(face)(shape.Orientation()==TopAbs_INTERNAL?embedded[face-1]:adjacent[face-1]).insert(i-1);
  }
  bool complete=true;for(const auto& owners:faceOwners)if(owners.empty())complete=false;
  for(std::size_t i=0;i<faceSources.size();++i)if(faceMap[i].empty()&&!faceSources[i].removed)complete=false;
  std::ostringstream out;out<<std::setprecision(17)<<"{\"format\":\"brep\",\"version\":2,\"documentId\":\""<<JsonEscape(documentId)<<"\",\"revision\":"<<revision<<",\"preprocessing\":{\"backend\":\"occt-history\",\"indexCertificateVersion\":1,\"indexOrder\":\"solids-first-recursive\",\"repairMode\":\""<<mode<<"\",\"tolerance\":"<<tolerance<<",\"conformal\":true,\"faceMappingComplete\":"<<(complete?"true":"false")<<"},\"bodies\":[";
  for(std::size_t i=0;i<bodies.size();++i){const auto& b=bodies[i];if(i)out<<',';out<<"{\"bodyId\":\""<<JsonEscape(b.Id)<<"\",\"name\":\""<<JsonEscape(b.Name)<<"\",\"kind\":\""<<b.Kind<<"\",\"bodyIdentity\":\""<<b.BodyIdentity<<"\",\"topologyIdentity\":\""<<b.TopologyIdentity<<"\",\"topologyRevision\":"<<b.TopologyRevision<<'}';}
  out<<"],\"solids\":[";
  for(int i=0;i<solids.Extent();++i){if(i)out<<',';out<<"{\"solidIndex\":"<<i<<',';geometry(out,solids(i+1),true);out<<",\"sources\":[";bool first=true;for(auto owner:solidOwners[i]){if(!first)out<<',';first=false;const auto& source=solidSources[owner];out<<"{\"bodyId\":\""<<JsonEscape(bodies[source.body].Id)<<"\",\"sourceSolidIndex\":"<<source.index<<'}';}out<<"]}";}
  out<<"],\"faces\":[";
  for(int i=0;i<faces.Extent();++i){if(i)out<<',';out<<"{\"faceIndex\":"<<i<<',';geometry(out,faces(i+1),false);out<<",\"adjacentSolidIndices\":[";bool first=true;for(int index:adjacent[i]){if(!first)out<<',';first=false;out<<index;}out<<"],\"embeddedSolidIndices\":[";first=true;for(int index:embedded[i]){if(!first)out<<',';first=false;out<<index;}out<<"],\"sources\":[";first=true;for(auto owner:faceOwners[i]){if(!first)out<<',';first=false;const auto& source=faceSources[owner];sourceJson(out,bodies[source.body],source.index);}out<<"]}";}
  out<<"],\"sourceFaces\":[";
  for(std::size_t i=0;i<faceSources.size();++i){if(i)out<<',';const auto& source=faceSources[i];out<<"{\"source\":";sourceJson(out,bodies[source.body],source.index);out<<",\"state\":\""<<(faceMap[i].empty()?(source.removed?"removed":"unresolved"):"mapped")<<"\",\"faceIndices\":[";bool first=true;for(int index:faceMap[i]){if(!first)out<<',';first=false;out<<index;}out<<"]}";}
  out<<']';if(diagnostics){diagnostics->Complete(output);out<<",\"diagnostics\":"<<diagnostics->Serialize();}out<<'}';return {output,out.str()};
}
}
