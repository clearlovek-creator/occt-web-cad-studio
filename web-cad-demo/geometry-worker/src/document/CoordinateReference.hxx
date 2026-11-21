#pragma once

#include "ParameterStore.hxx"
#include "TopologyNaming.hxx"
#include "../features/FeatureNode.hxx"

#include <TopoDS_Face.hxx>
#include <set>
#include <vector>

namespace occweb
{
// The selected historical output, not the mutable current Body, owns the face.
void UpdateFaceCoordinateFrame(CoordinateSystemRecord& record, const TopoDS_Face& face,
                               bool orthonormal = true);
void ResolveFaceCoordinate(CoordinateSystemRecord& record, const TopoDS_Shape& shape,
                          const TopologyNames& names);
std::vector<std::string> FeatureCoordinateIds(const FeatureNode& feature);
std::set<std::string> FeatureCoordinateSources(const FeatureNode& feature,
                                             const CoordinateSystemStore& coordinates);
std::vector<std::size_t> CoordinateReplayOrder(const std::vector<FeatureNode>& features,
                                              const CoordinateSystemStore& coordinates,
                                              const std::string& inspectionFeatureId = "");
bool ApplyFeatureCoordinates(FeatureNode& feature, const CoordinateSystemStore& coordinates);
void InvalidateMissingCoordinateSources(CoordinateSystemStore& coordinates,
                                       const std::vector<FeatureNode>& features);
}
