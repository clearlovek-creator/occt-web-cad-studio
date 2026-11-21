#pragma once
#include "FeatureNode.hxx"
#include "../document/TopologyNaming.hxx"
namespace occweb
{
struct PrimitiveBuildResult { TopoDS_Shape Shape; TopologyNames Names; };
PrimitiveBuildResult BuildNamedPrimitive(const FeatureNode& feature);
}
