#include "MeshWireStore.hxx"
#include <gmsh.h>
#include <cmath>
#include <cstring>
#include <filesystem>
#include <sstream>
#include <stdexcept>

namespace {
constexpr std::size_t chunkScalars=131070; // <=1 MiB and a whole number of segments.
constexpr std::uint64_t maximumBytes=2ULL*1024*1024*1024;
}
MeshWireStore::MeshWireStore(const std::string& path):output(std::filesystem::path(path),std::ios::binary|std::ios::trunc){
  if(!output)throw std::runtime_error("Cannot write mesh wire sidecar.");
}
std::string MeshWireStore::Write(int dimension,int tag,const std::unordered_map<std::size_t,std::array<double,3>>& points){
  const std::string key="wire-"+std::to_string(dimension)+"-"+std::to_string(tag);
  if(wires.count(key))return key;
  Wire wire;wire.key=key;
  std::vector<int> types;std::vector<std::vector<std::size_t>> elements,nodes;
  gmsh::model::mesh::getElements(types,elements,nodes,dimension,tag);
  const std::vector<std::pair<int,int>> edges=dimension==3?std::vector<std::pair<int,int>>{{0,1},{0,2},{0,3},{1,2},{1,3},{2,3}}:std::vector<std::pair<int,int>>{{0,1},{1,2},{2,0}};
  std::vector<unsigned char> buffer;buffer.reserve(chunkScalars*8);
  const auto flush=[&](){if(buffer.empty())return;if(bytes+buffer.size()>maximumBytes)throw std::runtime_error("Mesh wire sidecar exceeds the 2 GiB budget.");output.write(reinterpret_cast<const char*>(buffer.data()),static_cast<std::streamsize>(buffer.size()));if(!output)throw std::runtime_error("Mesh wire sidecar write failed.");wire.chunks.push_back({bytes,buffer.size()});bytes+=buffer.size();buffer.clear();};
  for(std::size_t block=0;block<types.size();++block){
    if(dimension==3&&types[block]!=4&&types[block]!=11)continue;
    if(dimension==2&&types[block]!=2&&types[block]!=9)continue;
    const auto count=elements[block].size();if(!count)continue;
    if(nodes[block].size()%count)throw std::runtime_error("Invalid mesh wire element stride.");
    const auto stride=nodes[block].size()/count;if(stride<(dimension==3?4u:3u))throw std::runtime_error("Incomplete mesh wire element.");
    for(std::size_t cell=0;cell<count;++cell)for(const auto& edge:edges)for(const int endpoint:{edge.first,edge.second}){
      const auto found=points.find(nodes[block][cell*stride+endpoint]);if(found==points.end())throw std::runtime_error("Mesh wire references a missing node.");
      for(double value:found->second){
        if(!std::isfinite(value))throw std::runtime_error("Mesh wire has a non-finite coordinate.");
        std::uint64_t bits;static_assert(sizeof(value)==sizeof(bits),"Expected binary64 double");std::memcpy(&bits,&value,sizeof(bits));for(int byte=0;byte<8;++byte)buffer.push_back(static_cast<unsigned char>((bits>>(8*byte))&255));++wire.scalars;
        if(buffer.size()==chunkScalars*8)flush();
      }
    }
  }
  flush();wires.emplace(key,std::move(wire));return key;
}
std::string MeshWireStore::Manifest(){
  output.flush();if(!output)throw std::runtime_error("Mesh wire sidecar flush failed.");
  std::ostringstream out;out<<"\"storage\":{\"version\":1,\"format\":\"float64-le\",\"bytes\":"<<bytes<<"},\"wires\":[";bool first=true;
  for(const auto& [key,wire]:wires){if(!first)out<<',';first=false;out<<"{\"key\":\""<<key<<"\",\"scalars\":"<<wire.scalars<<",\"chunks\":[";for(std::size_t i=0;i<wire.chunks.size();++i){if(i)out<<',';const auto& chunk=wire.chunks[i];out<<"{\"offset\":"<<chunk.offset<<",\"bytes\":"<<chunk.bytes<<'}';}out<<"]}";}out<<']';return out.str();
}
