#include "MeshSizing.hxx"
#include <gmsh.h>
#include <iostream>
#include <stdexcept>
#include <cmath>
using namespace occweb;
void require(bool value,const std::string& message){if(!value)throw std::runtime_error(message);}
int main(){try{
  gmsh::initialize();gmsh::option::setNumber("General.Terminal",0);gmsh::model::add("size-test");const int box=gmsh::model::occ::addBox(0,0,0,6,6,6);gmsh::model::occ::synchronize();
  double oldMax,oldPoints;gmsh::option::getNumber("Mesh.MeshSizeMax",oldMax);gmsh::option::getNumber("Mesh.MeshSizeFromPoints",oldPoints);
  auto count=[](){std::vector<std::size_t> nodes;std::vector<double> points,parameters;gmsh::model::mesh::getNodes(nodes,points,parameters);return nodes.size();};
  std::size_t coarse=0;{const auto p=JsonParser(R"({"sizing":{"version":1,"globalSize":3,"rules":[]}})").Parse();MeshSizingScope scope(p,nullptr);gmsh::model::mesh::generate(3);coarse=count();require(!scope.Report().empty(),"Global size must produce an execution report");}
  double current;gmsh::option::getNumber("Mesh.MeshSizeMax",current);require(current==oldMax,"Size maximum leaked to another request");gmsh::option::getNumber("Mesh.MeshSizeFromPoints",current);require(current==oldPoints,"Point-size policy leaked to another request");std::vector<int> fields;gmsh::model::mesh::field::list(fields);require(fields.empty(),"Request fields must be removed");
  gmsh::model::mesh::clear();PreparedMeshMapping mapping;mapping.Manifest=JsonParser(R"({"bodies":[{"bodyId":"body-1","bodyIdentity":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","topologyIdentity":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","topologyRevision":1}]})").Parse();mapping.VolumeSources[box].push_back({"body-1",0});
  const auto p=JsonParser(R"({"sizing":{"version":1,"globalSize":3,"rules":[{"id":"local","size":1,"target":{"kind":"body","bodyId":"body-1","bodyIdentity":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","topologyIdentity":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","topologyRevision":1}}]}})").Parse();
  {MeshSizingScope scope(p,&mapping);gmsh::model::mesh::generate(3);require(count()>coarse*2,"Body-restricted sizing must actually refine tetrahedra");const auto report=JsonParser(scope.Report()).Parse();require(report.At("rules").AsArray()[0].At("volumeTags").AsArray()[0].AsInteger()==box,"Report must identify the actual mapped volume");}
  bool refused=false;try{MeshSizingScope scope(p,nullptr);}catch(const MeshSizingError& error){refused=error.Code=="MESH_SIZING_TARGET_UNRESOLVED";}require(refused,"A local rule without proven ownership must not be silently ignored");
  gmsh::model::mesh::field::list(fields);require(fields.empty(),"Rejected sizing must not leave fields");gmsh::finalize();std::cout<<"PASS real mesh size fields refine only mapped entities, restore options and refuse unproven targets\n";return 0;
}catch(const std::exception& error){std::cerr<<error.what()<<'\n';try{gmsh::finalize();}catch(...){}return 1;}catch(...){std::cerr<<"Gmsh sizing test failed\n";return 1;}}
