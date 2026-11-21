#pragma once
#include <array>
#include <cstdint>
#include <fstream>
#include <map>
#include <string>
#include <unordered_map>
#include <vector>

/** Optional bounded wire sidecar. Never change the saved MSH or its topology. */
class MeshWireStore {
public:
  explicit MeshWireStore(const std::string& path);
  std::string Write(int dimension,int tag,const std::unordered_map<std::size_t,std::array<double,3>>& points);
  std::string Manifest();
private:
  struct Chunk {std::uint64_t offset=0,bytes=0;};
  struct Wire {std::string key;std::uint64_t scalars=0;std::vector<Chunk> chunks;};
  std::ofstream output;
  std::map<std::string,Wire> wires;
  std::uint64_t bytes=0;
};
