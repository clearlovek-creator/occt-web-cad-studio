#include "MeshOptimization.hxx"
#include "MeshSizing.hxx"
#include <gmsh.h>
#include <iostream>
#include <stdexcept>
using namespace occweb;
void require(bool value,const std::string& message){if(!value)throw std::runtime_error(message);}
int main(){try{
  gmsh::initialize();gmsh::option::setNumber("General.Terminal",0);gmsh::model::add("optimization-test");const int box=gmsh::model::occ::addBox(0,0,0,6,6,6);gmsh::model::occ::synchronize();gmsh::model::mesh::generate(3);
  const auto none=JsonParser(R"({"qualityThreshold":0.2})").Parse();require(OptimizeMesh(none,{}).empty(),"Optimization must remain opt-in");
  const auto request=JsonParser(R"({"qualityThreshold":0.2,"optimization":{"version":1,"method":"netgen","iterations":5}})").Parse();const auto report=JsonParser(OptimizeMesh(request,{{box,{"body-1"}}})).Parse();require(report.GetString("method")=="netgen"&&report.GetInteger("iterations")==5,"Missing exact execution settings");require(report.At("before").GetInteger("tetraCount")>0&&report.At("after").GetInteger("tetraCount")>0,"Missing actual before/after quality");
  for(const auto& text:{R"({"optimization":{"version":1,"method":"other","iterations":5}})",R"({"optimization":{"version":1,"method":"netgen","iterations":6}})",R"({"optimization":{"version":1,"method":"netgen","iterations":5,"ignored":true}})"}){bool refused=false;try{OptimizeMesh(JsonParser(text).Parse(),{});}catch(...){refused=true;}require(refused,"Invalid optimization was silently accepted");}
  PreparedMeshMapping mapping;mapping.Manifest=JsonParser(R"({"bodies":[{"bodyId":"body-1","bodyIdentity":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","topologyIdentity":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","topologyRevision":1}]})").Parse();mapping.VolumeSources[box].push_back({"body-1",0});gmsh::vectorpair faces;gmsh::model::getBoundary({{3,box}},faces,false,false,false);for(auto [dim,tag]:faces)if(dim==2)mapping.SurfaceSources[tag]=JsonParser(R"([{"bodyId":"body-1"}])").Parse();
  const auto sized=JsonParser(R"({"sizing":{"version":1,"globalSize":3,"rules":[{"id":"graded","size":1,"transitionDistance":2,"target":{"kind":"body","bodyId":"body-1","bodyIdentity":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","topologyIdentity":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","topologyRevision":1}}]}})").Parse();
  {MeshSizingScope scope(sized,&mapping);std::vector<int> fields;gmsh::model::mesh::field::list(fields);bool threshold=false;for(int field:fields){std::string type;gmsh::model::mesh::field::getType(field,type);if(type=="Threshold")threshold=true;}require(threshold,"Transition did not install a real threshold field");const auto proof=JsonParser(scope.Report()).Parse().At("rules").AsArray()[0].At("transition");require(proof.GetNumber("distance")==2&&proof.GetInteger("sampling")==100,"Transition report missing actual configuration");}
  std::vector<int> remaining;gmsh::model::mesh::field::list(remaining);require(remaining.empty(),"Transition fields leaked after request");
  mapping.SurfaceSources.clear();bool refused=false;try{MeshSizingScope scope(sized,&mapping);}catch(const MeshSizingError&){refused=true;}require(refused,"Unproven transition surfaces were silently ignored");gmsh::model::mesh::field::list(remaining);require(remaining.empty(),"Rejected transition leaked fields");gmsh::finalize();std::cout<<"PASS explicit Netgen quality report, strict input and source-surface transition lifecycle\n";return 0;
}catch(const std::exception& error){std::cerr<<error.what()<<'\n';return 1;}catch(...){std::cerr<<"Mesh optimization test failed\n";return 1;}}
