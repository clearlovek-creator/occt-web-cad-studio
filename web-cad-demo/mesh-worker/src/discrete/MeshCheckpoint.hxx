// SPDX-License-Identifier: GPL-3.0-or-later
#pragma once
#include "MeshSnapshot.hxx"
#include "QualityControl.hxx"
namespace occweb::discrete {
struct MeshCheckpoint {
  Point worldOrigin;
  std::vector<std::size_t> pointNodeTags;
  MeshSnapshot mesh;
};
JsonValue checkpointJson(const MeshCheckpoint&, bool embeddedMode = false);
MeshCheckpoint parseCheckpoint(const JsonValue&, bool embeddedMode = false);
void restoreFreshCheckpoint(const MeshCheckpoint&, const JsonValue& generationInput, bool patched = false);
JsonValue CreateVolumeCheckpoint(const JsonValue&);
JsonValue OptimizeVolumeCheckpoint(const JsonValue&);
JsonValue CreatePatchedVolumeCheckpoint(const JsonValue&);
JsonValue OptimizePatchedVolumeCheckpoint(const JsonValue&);
} // namespace occweb::discrete
