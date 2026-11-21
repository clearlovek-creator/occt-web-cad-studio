// SPDX-License-Identifier: GPL-3.0-or-later
#pragma once
#include "protocol/Json.hxx"
#include <cstddef>
struct VolumePartitionLimits {
  static constexpr std::size_t SourceSolids=6,Regions=32,InputTriangles=4096;
  static constexpr std::size_t Points=60000,BoundaryTriangles=20000,Cells=128;
  static constexpr std::size_t ClassificationPairs=100000,NefVertices=100000;
};
occweb::JsonValue PartitionSourceVolumes(const occweb::JsonValue& input, bool constrainSheets = false);
