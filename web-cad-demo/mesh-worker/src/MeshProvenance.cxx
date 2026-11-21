#include "MeshProvenance.hxx"
#include <gmsh.h>
#include <algorithm>
#include <cmath>
#include <iomanip>
#include <set>
#include <sstream>
#include <stdexcept>

namespace occweb {
namespace {
std::string json(const JsonValue& value) {
  std::ostringstream out;out<<std::setprecision(17);
  if(value.IsNull())out<<"null";
  else if(value.IsBoolean())out<<(value.AsBoolean()?"true":"false");
  else if(value.IsNumber())out<<value.AsNumber();
  else if(value.IsString())out<<'"'<<JsonEscape(value.AsString())<<'"';
  else if(value.IsArray()){out<<'[';bool first=true;for(const auto& item:value.AsArray()){if(!first)out<<',';first=false;out<<json(item);}out<<']';}
  else {out<<'{';bool first=true;for(const auto& [key,item]:value.AsObject()){if(!first)out<<',';first=false;out<<'"'<<JsonEscape(key)<<"\":"<<json(item);}out<<'}';}
  return out.str();
}
std::vector<int> entities(int dimension) {
  gmsh::vectorpair values;gmsh::model::getEntities(values,dimension);std::vector<int> result;
  for(const auto& value:values)result.push_back(value.second);std::sort(result.begin(),result.end());return result;
}
// Restore import options even when validation fails. Worker processes also
// support unrelated file operations and must not inherit this strict profile.
struct ImportOptions {
  std::vector<std::pair<std::string,double>> previous;
  ImportOptions(){for(const char* name:{"Geometry.OCCAutoFix","Geometry.OCCFixDegenerated","Geometry.OCCFixSmallEdges","Geometry.OCCFixSmallFaces","Geometry.OCCSewFaces","Geometry.OCCMakeSolids"}){double value;gmsh::option::getNumber(name,value);previous.emplace_back(name,value);gmsh::option::setNumber(name,0);}}
  ~ImportOptions(){for(const auto& [name,value]:previous)try{gmsh::option::setNumber(name,value);}catch(...){}}
};
void verifyGeometry(const JsonValue& record,int dimension,int tag,int certificateVersion) {
  double mass,x,y,z,a,b,c,d,e,f;
  gmsh::model::occ::getMass(dimension,tag,mass);gmsh::model::occ::getCenterOfMass(dimension,tag,x,y,z);
  gmsh::model::getBoundingBox(dimension,tag,a,b,c,d,e,f);
  const auto* certificate=record.Find("indexCertificate");
  if((certificateVersion==1&&!certificate)||(certificateVersion==0&&certificate))throw std::runtime_error("Prepared BREP index certificate version is missing or inconsistent.");
  if(certificate&&(certificate->GetInteger("version")!=1||certificate->GetString("boundsPolicy")!="occt-brep-conservative"||certificate->GetBooleanOr("triangulationUsed",true)))throw std::runtime_error("Unsupported prepared BREP index certificate policy.");
  const auto& bounds=certificate?certificate->At("bounds"):record.At("bounds");
  const auto& min=bounds.At("min").AsArray();const auto& max=bounds.At("max").AsArray();const auto& center=record.At("centroid").AsArray();
  if(min.size()!=3||max.size()!=3||center.size()!=3)throw std::runtime_error("Prepared BREP geometry certificate is incomplete.");
  for(int i=0;i<3;i++)if(!std::isfinite(min[i].AsNumber())||!std::isfinite(max[i].AsNumber())||!std::isfinite(center[i].AsNumber())||min[i].AsNumber()>max[i].AsNumber())throw std::runtime_error("Prepared BREP index certificate bounds are invalid.");
  const double diagonal=std::hypot(std::hypot(max[0].AsNumber()-min[0].AsNumber(),max[1].AsNumber()-min[1].AsNumber()),max[2].AsNumber()-min[2].AsNumber());
  const double tolerance=1e-6*std::max(diagonal,1.0),expected=record.GetNumber(dimension==3?"volume":"area");
  if(certificate){const auto& analytic=record.At("bounds");const auto& lo=analytic.At("min").AsArray();const auto& hi=analytic.At("max").AsArray();if(lo.size()!=3||hi.size()!=3)throw std::runtime_error("Invalid prepared analytic bounds.");for(int i=0;i<3;i++)if(!std::isfinite(lo[i].AsNumber())||!std::isfinite(hi[i].AsNumber())||lo[i].AsNumber()>hi[i].AsNumber()||lo[i].AsNumber()<min[i].AsNumber()-tolerance||hi[i].AsNumber()>max[i].AsNumber()+tolerance)throw std::runtime_error("Analytic bounds contradict the prepared index certificate.");}
  const double actual[]={a,b,c,d,e,f},certified[]={min[0].AsNumber(),min[1].AsNumber(),min[2].AsNumber(),max[0].AsNumber(),max[1].AsNumber(),max[2].AsNumber()};
  bool valid=std::isfinite(mass)&&std::abs(mass-expected)<=1e-7*std::max(std::abs(expected),1.0);
  for(int i=0;i<6;++i)valid=valid&&std::isfinite(actual[i])&&std::abs(actual[i]-certified[i])<=tolerance;
  valid=valid&&std::abs(x-center[0].AsNumber())<=tolerance&&std::abs(y-center[1].AsNumber())<=tolerance&&std::abs(z-center[2].AsNumber())<=tolerance;
  if(!valid){std::ostringstream detail;detail<<std::setprecision(17)<<"Prepared BREP "<<(dimension==3?"solid":"face")<<" index certificate failed at "<<tag<<" (expected mass "<<expected<<", imported "<<mass<<", expected center "<<json(record.At("centroid"))<<", imported ["<<x<<','<<y<<','<<z<<"], expected bounds "<<json(bounds)<<", imported bounds {min:["<<a<<','<<b<<','<<c<<"],max:["<<d<<','<<e<<','<<f<<"]}, tolerance "<<tolerance<<"); no nearest-entity fallback was used.";throw std::runtime_error(detail.str());}
}
std::string anchorKey(const JsonValue& source){return source.GetString("bodyId")+"/"+source.GetString("cadFaceId");}
}
bool IsPreparedMesh(const JsonValue& parameters) {
  const auto* manifest=parameters.Find("bodyManifest");return manifest&&manifest->GetIntegerOr("version",0)==2;
}
PreparedMeshMapping ImportPreparedMesh(const std::string& path,const JsonValue& manifest) {
  if(manifest.GetString("format")!="brep"||manifest.GetInteger("version")!=2||manifest.At("preprocessing").GetString("backend")!="occt-history"||manifest.At("preprocessing").GetStringOr("indexOrder","")!="solids-first-recursive"||!manifest.At("preprocessing").GetBooleanOr("conformal",false))
    throw std::runtime_error("Unsupported prepared mesh provenance contract.");
  const int certificateVersion=manifest.At("preprocessing").GetIntegerOr("indexCertificateVersion",0);
  if(certificateVersion!=0&&certificateVersion!=1)throw std::runtime_error("Unsupported prepared index certificate version.");
  gmsh::clear();{ImportOptions options;gmsh::model::add("prepared-cad-mesh");gmsh::vectorpair imported;gmsh::model::occ::importShapes(path,imported,false,"brep");gmsh::model::occ::synchronize();}
  PreparedMeshMapping result;result.Manifest=manifest;result.VolumeTags=entities(3);result.SurfaceTags=entities(2);
  const auto& solids=manifest.At("solids").AsArray();const auto& faces=manifest.At("faces").AsArray();
  if(solids.size()!=result.VolumeTags.size()||faces.size()!=result.SurfaceTags.size())throw std::runtime_error("Prepared BREP entity counts changed during import; provenance was not guessed.");
  std::map<std::string,JsonValue> bodies;
  for(const auto& body:manifest.At("bodies").AsArray())if(!bodies.emplace(body.GetString("bodyId"),body).second)throw std::runtime_error("Duplicate Body provenance.");
  for(std::size_t i=0;i<solids.size();++i){
    const auto& solid=solids[i];if(solid.GetInteger("solidIndex")!=static_cast<int>(i))throw std::runtime_error("Prepared solid indices are not contiguous.");
    const int tag=result.VolumeTags[i];verifyGeometry(solid,3,tag,certificateVersion);std::set<std::pair<std::string,int>> seen;
    for(const auto& source:solid.At("sources").AsArray()){
      const std::string body=source.GetString("bodyId");const int index=source.GetInteger("sourceSolidIndex");
      if(!bodies.count(body)||index<0||!seen.emplace(body,index).second)throw std::runtime_error("Invalid prepared solid provenance.");
      result.VolumeSources[tag].push_back({body,index});
    }
    if(result.VolumeSources[tag].empty())throw std::runtime_error("Prepared solid has no source Body.");
  }
  std::vector<std::set<int>> adjacent(faces.size());
  std::map<int,std::size_t> faceIndex;for(std::size_t i=0;i<result.SurfaceTags.size();++i)faceIndex[result.SurfaceTags[i]]=i;
  for(std::size_t i=0;i<result.VolumeTags.size();++i){gmsh::vectorpair boundary;gmsh::model::getBoundary({{3,result.VolumeTags[i]}},boundary,true,false,false);for(const auto& entity:boundary)if(entity.first==2){const auto found=faceIndex.find(std::abs(entity.second));if(found==faceIndex.end())throw std::runtime_error("Uncertified mesh boundary.");adjacent[found->second].insert(static_cast<int>(i));}}
  std::map<std::string,std::set<int>> forward,backward;
  for(std::size_t i=0;i<faces.size();++i){
    const auto& face=faces[i];if(face.GetInteger("faceIndex")!=static_cast<int>(i))throw std::runtime_error("Prepared face indices are not contiguous.");
    const int tag=result.SurfaceTags[i];verifyGeometry(face,2,tag,certificateVersion);std::set<int> expected;
    for(const auto& value:face.At("adjacentSolidIndices").AsArray())expected.insert(value.AsInteger());
    if(expected!=adjacent[i]){std::ostringstream detail;detail<<"Prepared face adjacency changed during import at "<<tag<<" (expected";for(int index:expected)detail<<' '<<index;detail<<", imported";for(int index:adjacent[i])detail<<' '<<index;detail<<"); provenance was not guessed.";throw std::runtime_error(detail.str());}
    for(const auto& value:face.At("embeddedSolidIndices").AsArray()){
      const int index=value.AsInteger();if(index<0||index>=static_cast<int>(result.VolumeTags.size())||expected.count(index))throw std::runtime_error("Invalid embedded face incidence.");
      gmsh::model::mesh::embed(2,{tag},3,result.VolumeTags[index]);
    }
    result.SurfaceSources[tag]=face.At("sources");std::set<std::string> seen;
    for(const auto& source:face.At("sources").AsArray()){
      const auto body=bodies.find(source.GetString("bodyId"));
      if(body==bodies.end()||source.GetString("bodyIdentity")!=body->second.GetString("bodyIdentity")||source.GetString("topologyIdentity")!=body->second.GetString("topologyIdentity")||source.GetInteger("topologyRevision")!=body->second.GetInteger("topologyRevision")||!seen.insert(anchorKey(source)).second)throw std::runtime_error("Invalid prepared face identity.");
      forward[anchorKey(source)].insert(static_cast<int>(i));
    }
  }
  std::map<std::string,std::set<int>> physical;
  for(const auto& entry:manifest.At("sourceFaces").AsArray()){
    const auto& source=entry.At("source");const auto key=anchorKey(source);if(backward.count(key))throw std::runtime_error("Duplicate CAD face provenance.");
    auto& indices=backward[key];for(const auto& value:entry.At("faceIndices").AsArray()){const int index=value.AsInteger();if(index<0||index>=static_cast<int>(faces.size())||!indices.insert(index).second)throw std::runtime_error("Invalid CAD face destination index.");physical[key].insert(result.SurfaceTags[index]);}
    const auto state=entry.GetString("state");if((state=="mapped")!=!indices.empty()||(state!="mapped"&&state!="removed"&&state!="unresolved"))throw std::runtime_error("Invalid CAD face provenance state.");
    if(indices!=forward[key])throw std::runtime_error("CAD face forward and reverse provenance disagree.");
  }
  for(const auto& [key,indices]:forward)if(!indices.empty()&&!backward.count(key))throw std::runtime_error("Missing reverse CAD face provenance.");
  for(const auto& [key,tags]:physical)if(!tags.empty())gmsh::model::addPhysicalGroup(2,std::vector<int>(tags.begin(),tags.end()),-1,"CADFace/"+key);
  return result;
}
std::string PreparedSurfaceSourcesJson(const PreparedMeshMapping& mapping,int tag) {
  const auto found=mapping.SurfaceSources.find(tag);return found==mapping.SurfaceSources.end()?"[]":json(found->second);
}
std::string PreparedBoundaryJson(const PreparedMeshMapping& mapping) {
  std::ostringstream out;out<<std::setprecision(17)<<"{\"version\":1,\"backend\":\"occt-history\",\"complete\":"<<(mapping.Manifest.At("preprocessing").GetBooleanOr("faceMappingComplete",false)?"true":"false")<<",\"repairMode\":"<<json(mapping.Manifest.At("preprocessing").At("repairMode"))<<",\"sourceFaces\":[";
  bool first=true;for(const auto& entry:mapping.Manifest.At("sourceFaces").AsArray()){
    if(!first)out<<',';first=false;out<<"{\"source\":"<<json(entry.At("source"))<<",\"state\":"<<json(entry.At("state"))<<",\"surfaceTags\":[";
    bool firstTag=true;for(const auto& index:entry.At("faceIndices").AsArray()){if(!firstTag)out<<',';firstTag=false;out<<mapping.SurfaceTags.at(index.AsInteger());}out<<"]}";
  }
  out<<"],\"surfaces\":[";for(std::size_t i=0;i<mapping.SurfaceTags.size();++i){if(i)out<<',';const int tag=mapping.SurfaceTags[i];const auto& face=mapping.Manifest.At("faces").AsArray()[i];std::vector<int> types;std::vector<std::vector<std::size_t>> tags,nodes;gmsh::model::mesh::getElements(types,tags,nodes,2,tag);std::size_t count=0;for(const auto& values:tags)count+=values.size();
    out<<"{\"meshFaceId\":\"mesh-face-"<<tag<<"\",\"surfaceTag\":"<<tag<<",\"area\":"<<face.GetNumber("area")<<",\"elementCount\":"<<count<<",\"sources\":"<<PreparedSurfaceSourcesJson(mapping,tag)<<",\"adjacentSolidIds\":[";
    bool firstSolid=true;for(const auto& index:face.At("adjacentSolidIndices").AsArray()){if(!firstSolid)out<<',';firstSolid=false;out<<"\"solid-"<<mapping.VolumeTags.at(index.AsInteger())<<'"';}out<<"],\"embeddedSolidIds\":[";firstSolid=true;for(const auto& index:face.At("embeddedSolidIndices").AsArray()){if(!firstSolid)out<<',';firstSolid=false;out<<"\"solid-"<<mapping.VolumeTags.at(index.AsInteger())<<'"';}out<<"]}";
  }out<<"]}";return out.str();
}
}
