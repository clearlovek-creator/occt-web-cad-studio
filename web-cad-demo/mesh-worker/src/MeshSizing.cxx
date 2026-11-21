#include "MeshSizing.hxx"
#include <gmsh.h>
#include <algorithm>
#include <cmath>
#include <regex>
#include <set>
#include <sstream>
#include <iomanip>

namespace occweb {namespace {
void invalid(const std::string& message){throw MeshSizingError("MESH_SIZING_INVALID",message);}
void keys(const JsonValue& value,const std::set<std::string>& allowed){if(!value.IsObject())invalid("Mesh sizing must use objects.");for(const auto& [key,item]:value.AsObject())if(!allowed.count(key))invalid("Unknown mesh sizing field: "+key);}
bool size(double value){return std::isfinite(value)&&value>=1e-6&&value<=1e6;}
std::string numbers(const std::set<int>& values){std::ostringstream out;out<<'[';bool first=true;for(int value:values){if(!first)out<<',';first=false;out<<value;}out<<']';return out.str();}
}
void MeshSizingScope::restore() noexcept{for(auto it=myFields.rbegin();it!=myFields.rend();++it)try{gmsh::model::mesh::field::remove(*it);}catch(...){}for(const auto& [name,value]:myOptions)try{gmsh::option::setNumber(name,value);}catch(...){}myFields.clear();myOptions.clear();}
MeshSizingScope::~MeshSizingScope(){restore();}
MeshSizingScope::MeshSizingScope(const JsonValue& parameters,const PreparedMeshMapping* mapping){
  const auto* input=parameters.Find("sizing");if(!input)return;
  try{
    keys(*input,{"version","globalSize","rules"});const double global=input->GetNumber("globalSize");
    if(input->GetInteger("version")!=1||!size(global)||!input->At("rules").IsArray()||input->At("rules").AsArray().size()>16)invalid("Invalid global mesh size or rule capacity.");
    struct Rule {JsonValue Value;std::set<int> Volumes,Surfaces;};std::vector<Rule> rules;std::set<std::string> ids,targets;double minimum=global;
    const std::regex identifier("^[A-Za-z0-9_-]{1,64}$"),identity("^[a-f0-9]{32}$");
    for(const auto& rule:input->At("rules").AsArray()){
      keys(rule,{"id","size","target","transitionDistance"});const auto& target=rule.At("target");keys(target,{"kind","bodyId","bodyIdentity","topologyIdentity","topologyRevision","cadFaceId"});
      const std::string id=rule.GetString("id"),kind=target.GetString("kind"),body=target.GetString("bodyId");const double local=rule.GetNumber("size");const int revision=target.GetInteger("topologyRevision");
      if(!std::regex_match(id,identifier)||!ids.insert(id).second||!size(local)||local>global||!std::regex_match(body,identifier)||!std::regex_match(target.GetString("bodyIdentity"),identity)||!std::regex_match(target.GetString("topologyIdentity"),identity)||revision<0||(kind!="body"&&kind!="face"))invalid("Invalid local mesh sizing rule.");
      if(rule.Has("transitionDistance")&&!size(rule.GetNumber("transitionDistance")))invalid("Transition distance must be a positive finite model length.");
      if(kind=="body"&&target.Has("cadFaceId")||kind=="face"&&!std::regex_match(target.GetString("cadFaceId"),std::regex("^face-"+std::to_string(revision)+"-[1-9][0-9]*$")))invalid("Face size target does not match its topology revision.");
      if(!targets.insert(JsonSerialize(target)).second)invalid("Duplicate local mesh sizing target.");
      if(!mapping)throw MeshSizingError("MESH_SIZING_TARGET_UNRESOLVED","Local sizing requires certified CAD provenance.");
      bool current=false;for(const auto& source:mapping->Manifest.At("bodies").AsArray())if(source.GetString("bodyId")==body&&source.GetString("bodyIdentity")==target.GetString("bodyIdentity")&&source.GetString("topologyIdentity")==target.GetString("topologyIdentity")&&source.GetInteger("topologyRevision")==revision)current=true;
      if(!current)throw MeshSizingError("MESH_SIZING_TARGET_STALE","Local mesh size target changed; select the geometry again.");
      Rule resolved{rule,{},{}};
      if(kind=="body")for(const auto& [tag,sources]:mapping->VolumeSources)for(const auto& source:sources)if(source.BodyId==body)resolved.Volumes.insert(tag);
      for(const auto& [tag,sources]:mapping->SurfaceSources)for(const auto& source:sources.AsArray())if(source.GetString("bodyId")==body&&(kind=="body"||source.GetString("cadFaceId")==target.GetString("cadFaceId")))resolved.Surfaces.insert(tag);
      if(resolved.Volumes.empty()&&resolved.Surfaces.empty())throw MeshSizingError("MESH_SIZING_TARGET_UNRESOLVED","No certified mesh entity remains for a requested local size target.");
      if(rule.Has("transitionDistance")&&resolved.Surfaces.empty())throw MeshSizingError("MESH_SIZING_TARGET_UNRESOLVED","A sizing transition needs certified source surfaces; it cannot be silently ignored.");
      minimum=std::min(minimum,local);rules.push_back(std::move(resolved));
    }
    // This worker can process multiple requests. Never leak this request's
    // meshing policy into later automatic or file-tool jobs.
    for(const auto& name:{"Mesh.MeshSizeMin","Mesh.MeshSizeMax","Mesh.MeshSizeFactor","Mesh.MeshSizeFromPoints","Mesh.MeshSizeFromCurvature","Mesh.MeshSizeExtendFromBoundary"}){double value;gmsh::option::getNumber(name,value);myOptions.emplace_back(name,value);}
    gmsh::option::setNumber("Mesh.MeshSizeMin",minimum);gmsh::option::setNumber("Mesh.MeshSizeMax",global);gmsh::option::setNumber("Mesh.MeshSizeFactor",1);gmsh::option::setNumber("Mesh.MeshSizeFromPoints",0);gmsh::option::setNumber("Mesh.MeshSizeFromCurvature",0);gmsh::option::setNumber("Mesh.MeshSizeExtendFromBoundary",0);
    const auto constant=[&](double value){const int tag=gmsh::model::mesh::field::add("MathEval");myFields.push_back(tag);gmsh::model::mesh::field::setString(tag,"F",JsonSerialize(JsonValue(value)));return tag;};
    std::vector<double> fields{static_cast<double>(constant(global))};
    for(const auto& rule:rules){const int source=constant(rule.Value.GetNumber("size")),restricted=gmsh::model::mesh::field::add("Restrict");myFields.push_back(restricted);gmsh::model::mesh::field::setNumber(restricted,"InField",source);gmsh::model::mesh::field::setNumber(restricted,"IncludeBoundary",1);gmsh::model::mesh::field::setNumbers(restricted,"VolumesList",std::vector<double>(rule.Volumes.begin(),rule.Volumes.end()));gmsh::model::mesh::field::setNumbers(restricted,"SurfacesList",std::vector<double>(rule.Surfaces.begin(),rule.Surfaces.end()));fields.push_back(restricted);
      if(rule.Value.Has("transitionDistance")){
        const int distance=gmsh::model::mesh::field::add("Distance");myFields.push_back(distance);gmsh::model::mesh::field::setNumbers(distance,"SurfacesList",std::vector<double>(rule.Surfaces.begin(),rule.Surfaces.end()));gmsh::model::mesh::field::setNumber(distance,"Sampling",100);
        const int transition=gmsh::model::mesh::field::add("Threshold");myFields.push_back(transition);gmsh::model::mesh::field::setNumber(transition,"InField",distance);gmsh::model::mesh::field::setNumber(transition,"SizeMin",rule.Value.GetNumber("size"));gmsh::model::mesh::field::setNumber(transition,"SizeMax",global);gmsh::model::mesh::field::setNumber(transition,"DistMin",0);gmsh::model::mesh::field::setNumber(transition,"DistMax",rule.Value.GetNumber("transitionDistance"));fields.push_back(transition);
      }
    }
    const int combined=gmsh::model::mesh::field::add("Min");myFields.push_back(combined);gmsh::model::mesh::field::setNumbers(combined,"FieldsList",fields);gmsh::model::mesh::field::setAsBackgroundMesh(combined);
    std::ostringstream out;out<<std::setprecision(17)<<"{\"version\":1,\"strategy\":\"min-restrict-v1\",\"globalSize\":"<<global<<",\"rules\":[";bool first=true;
    for(const auto& rule:rules){if(!first)out<<',';first=false;out<<"{\"id\":"<<JsonSerialize(rule.Value.At("id"))<<",\"size\":"<<rule.Value.GetNumber("size")<<",\"target\":"<<JsonSerialize(rule.Value.At("target"))<<",\"volumeTags\":"<<numbers(rule.Volumes)<<",\"surfaceTags\":"<<numbers(rule.Surfaces);if(rule.Value.Has("transitionDistance"))out<<",\"transition\":{\"distance\":"<<rule.Value.GetNumber("transitionDistance")<<",\"sampling\":100,\"basis\":\"source-surfaces-distance-v1\"}";out<<'}';}out<<"]}";myReport=out.str();
  }catch(...){restore();throw;}
}
}
