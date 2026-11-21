// SPDX-License-Identifier: GPL-3.0-or-later
#include "MeshSnapshot.hxx"
#include "QualityControl.hxx"
#include <gmsh.h>
#include <algorithm>
#include <numeric>
#include <tuple>

namespace occweb::discrete {
namespace {
void check(bool value, const char* message) {
  if(!value) throw QualityError("MESH_SNAPSHOT_INVALID", message);
}
}
bool EntityMesh::operator==(const EntityMesh& other) const {
  return std::tie(dimension,tag,boundary,embedded,nodes,coordinates,parameters,types,elements,vertices)
      == std::tie(other.dimension,other.tag,other.boundary,other.embedded,other.nodes,other.coordinates,other.parameters,other.types,other.elements,other.vertices);
}

MeshSnapshot captureMesh() {
  gmsh::vectorpair entities;
  gmsh::model::getEntities(entities);
  check(entities.size() <= 200000, "In-memory entity snapshot exceeds its budget.");
  std::sort(entities.begin(),entities.end());
  MeshSnapshot result;
  std::size_t nodes = 0, elements = 0;
  for(const auto& entity : entities) {
    EntityMesh row;
    row.dimension=entity.first;row.tag=entity.second;
    gmsh::vectorpair boundary;
    gmsh::model::getBoundary({entity},boundary,false,true,false);
    for(const auto& use:boundary){check(use.first==entity.first-1,"Unexpected entity boundary dimension.");row.boundary.push_back(use.second);}
    std::sort(row.boundary.begin(),row.boundary.end());
    if(entity.first>=2){gmsh::model::mesh::getEmbedded(entity.first,entity.second,row.embedded);std::sort(row.embedded.begin(),row.embedded.end());}
    std::vector<std::size_t> tags;
    std::vector<double> coordinates,parameters;
    gmsh::model::mesh::getNodes(tags,coordinates,parameters,entity.first,entity.second,false,true);
    nodes += tags.size();
    check(nodes<=100000 && coordinates.size()==3*tags.size(),"In-memory node snapshot exceeds its budget.");
    check(parameters.empty() || parameters.size()==std::size_t(entity.first)*tags.size(),"Unexpected parametric node inventory.");
    std::vector<std::size_t> order(tags.size());std::iota(order.begin(),order.end(),0);
    std::sort(order.begin(),order.end(),[&](std::size_t a,std::size_t b){return tags[a]<tags[b];});
    for(const auto i : order) {
      row.nodes.push_back(tags[i]);
      for(int k=0;k<3;++k)row.coordinates.push_back(coordinates[3*i+k]);
      if(!parameters.empty())for(int k=0;k<entity.first;++k)row.parameters.push_back(parameters[entity.first*i+k]);
    }
    std::vector<int> types;
    std::vector<std::vector<std::size_t>> ids,vertices;
    gmsh::model::mesh::getElements(types,ids,vertices,entity.first,entity.second);
    std::vector<std::size_t> blocks(types.size());std::iota(blocks.begin(),blocks.end(),0);
    std::sort(blocks.begin(),blocks.end(),[&](std::size_t a,std::size_t b){return types[a]<types[b];});
    for(const auto block : blocks) {
      check(!ids[block].empty() && vertices[block].size()%ids[block].size()==0,"Invalid in-memory element inventory.");
      const auto width=vertices[block].size()/ids[block].size();
      check(width>=1 && width<=4,"Snapshot only supports first-order mesh elements.");
      elements+=ids[block].size();check(elements<=1000000,"In-memory element snapshot exceeds its budget.");
      row.types.push_back(types[block]);row.elements.emplace_back();row.vertices.emplace_back();
      std::vector<std::size_t> sorted(ids[block].size());std::iota(sorted.begin(),sorted.end(),0);
      std::sort(sorted.begin(),sorted.end(),[&](std::size_t a,std::size_t b){return ids[block][a]<ids[block][b];});
      for(const auto i : sorted) {
        row.elements.back().push_back(ids[block][i]);
        for(std::size_t k=0;k<width;++k)row.vertices.back().push_back(vertices[block][width*i+k]);
      }
    }
    result.entities.push_back(std::move(row));
  }
  return result;
}

void validateMeshTopology(const MeshSnapshot& snapshot) {
  gmsh::vectorpair entities;
  gmsh::model::getEntities(entities);std::sort(entities.begin(),entities.end());
  gmsh::vectorpair expected;
  for(const auto& row:snapshot.entities)expected.emplace_back(row.dimension,row.tag);
  check(entities==expected,"Optimizer changed model entities; restoration refused.");
  for(const auto& row:snapshot.entities){
    gmsh::vectorpair boundary,embedded;gmsh::model::getBoundary({{row.dimension,row.tag}},boundary,false,true,false);
    std::vector<int> tags;for(const auto& use:boundary){check(use.first==row.dimension-1,"Restored boundary dimension differs.");tags.push_back(use.second);}std::sort(tags.begin(),tags.end());
    if(row.dimension>=2)gmsh::model::mesh::getEmbedded(row.dimension,row.tag,embedded);std::sort(embedded.begin(),embedded.end());
    check(tags==row.boundary&&embedded==row.embedded,"Optimizer changed boundary or embedded entity relationships.");
  }
}
void restoreMesh(const MeshSnapshot& snapshot) {
  validateMeshTopology(snapshot);
  gmsh::model::mesh::clear();
  for(const auto& row:snapshot.entities)
    if(!row.nodes.empty())gmsh::model::mesh::addNodes(row.dimension,row.tag,row.nodes,row.coordinates,row.parameters);
  for(const auto& row:snapshot.entities)
    if(!row.types.empty())gmsh::model::mesh::addElements(row.dimension,row.tag,row.types,row.elements,row.vertices);
  const auto actual=captureMesh();
  if(!(actual==snapshot)){
    if(actual.entities.size()!=snapshot.entities.size())throw QualityError("MESH_SNAPSHOT_INVALID","Restored entity count differs from the checkpoint.");
    for(std::size_t i=0;i<actual.entities.size();++i){const auto& a=actual.entities[i];const auto& b=snapshot.entities[i];const char* field=a.dimension!=b.dimension||a.tag!=b.tag?"identity":a.boundary!=b.boundary?"boundary":a.embedded!=b.embedded?"embedded relationships":a.nodes!=b.nodes?"node tags":a.coordinates!=b.coordinates?"coordinates":a.parameters!=b.parameters?"parameters":a.types!=b.types?"element types":a.elements!=b.elements?"element tags":a.vertices!=b.vertices?"connectivity":nullptr;if(field)throw QualityError("MESH_SNAPSHOT_INVALID","Restored entity "+std::to_string(b.dimension)+":"+std::to_string(b.tag)+" differs in "+field+"; checkpoint was not adopted.");}
    throw QualityError("MESH_SNAPSHOT_INVALID","Restored mesh differs from the checkpoint.");
  }
}
} // namespace occweb::discrete
