#include "MeshWireStore.hxx"
#include <gmsh.h>
#include <array>
#include <chrono>
#include <iostream>
#include <stdexcept>
#include <unordered_map>

// A valid structured discrete tetrahedral grid for serializer scale testing.
// This is deliberately not a claim about CAD repair or mesher throughput.
int main(int argc,char** argv){
  try{
    if(argc!=3)throw std::runtime_error("Usage: mesh_wire_benchmark subdivisions output.bin");
    const int n=std::stoi(argv[1]);if(n<1||n>70)throw std::runtime_error("Subdivisions must be 1..70");
    gmsh::initialize();gmsh::option::setNumber("General.Terminal",0);gmsh::model::add("serialization-grid");
    const int volume=gmsh::model::addDiscreteEntity(3);
    const auto node=[n](int x,int y,int z){return static_cast<std::size_t>((z*(n+1)+y)*(n+1)+x+1);};
    std::vector<std::size_t> tags,cellTags,corners;std::vector<double> coordinates;
    std::unordered_map<std::size_t,std::array<double,3>> points;
    for(int z=0;z<=n;++z)for(int y=0;y<=n;++y)for(int x=0;x<=n;++x){const auto tag=node(x,y,z);tags.push_back(tag);coordinates.insert(coordinates.end(),{double(x),double(y),double(z)});points.emplace(tag,std::array<double,3>{double(x),double(y),double(z)});}
    constexpr int tets[6][4]={{0,1,3,7},{0,3,2,7},{0,2,6,7},{0,6,4,7},{0,4,5,7},{0,5,1,7}};
    for(int z=0;z<n;++z)for(int y=0;y<n;++y)for(int x=0;x<n;++x){
      const std::size_t nodes[8]={node(x,y,z),node(x+1,y,z),node(x,y+1,z),node(x+1,y+1,z),node(x,y,z+1),node(x+1,y,z+1),node(x,y+1,z+1),node(x+1,y+1,z+1)};
      for(const auto& tet:tets){cellTags.push_back(cellTags.size()+1);for(int index:tet)corners.push_back(nodes[index]);}
    }
    gmsh::model::mesh::addNodes(3,volume,tags,coordinates);gmsh::model::mesh::addElementsByType(volume,4,cellTags,corners);
    const auto start=std::chrono::steady_clock::now();
    MeshWireStore store(argv[2]);const auto key=store.Write(3,volume,points);const auto repeated=store.Write(3,volume,points);
    if(key!=repeated)throw std::runtime_error("Shared wire key changed");
    const auto manifest=store.Manifest();const auto elapsed=std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now()-start).count();
    std::cout<<"{\"cells\":"<<cellTags.size()<<",\"nodes\":"<<tags.size()<<",\"elapsedMs\":"<<elapsed<<",\"render\":{\"kind\":\"wire\",\"dimension\":3,\"positions\":[],\"wirePositions\":[],\"groups\":[{\"kind\":\"solid\",\"solidId\":\"solid-"<<volume<<"\",\"wireKey\":\""<<key<<"\",\"wirePositions\":[]}],"<<manifest<<"}}"<<std::endl;
    gmsh::finalize();return 0;
  }catch(const std::exception& error){std::cerr<<error.what()<<std::endl;return 1;}
}
