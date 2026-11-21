// SPDX-License-Identifier: GPL-3.0-or-later
#pragma once
#include <cstddef>
#include <vector>
#include <utility>

namespace occweb::discrete {
// No paths or process-global recovery. The same bounded snapshot can be
// serialized as an explicit checkpoint for a separately owned process.
struct EntityMesh {
  int dimension = 0, tag = 0;
  std::vector<int> boundary;
  std::vector<std::pair<int,int>> embedded;
  std::vector<std::size_t> nodes;
  std::vector<double> coordinates, parameters;
  std::vector<int> types;
  std::vector<std::vector<std::size_t>> elements, vertices;
  bool operator==(const EntityMesh&) const;
};
struct MeshSnapshot {
  std::vector<EntityMesh> entities;
  bool operator==(const MeshSnapshot& other) const {return entities == other.entities;}
};
MeshSnapshot captureMesh();
void validateMeshTopology(const MeshSnapshot&);
void restoreMesh(const MeshSnapshot&);
} // namespace occweb::discrete
