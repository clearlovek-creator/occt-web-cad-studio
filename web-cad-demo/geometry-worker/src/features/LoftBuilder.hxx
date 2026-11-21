#pragma once
#include "FeatureNode.hxx"
#include "../document/TopologyNaming.hxx"
#include <TopoDS_Face.hxx>
#include <TopoDS_Wire.hxx>
namespace occweb
{
struct LoftProfile { TopoDS_Face Face; TopologyNames Names; std::string Proof; std::vector<TopoDS_Wire> Holes; std::vector<std::string> HoleProofs; };
struct LoftBuildResult { TopoDS_Shape Shape; TopologyNames Names; TopoDS_Face StartCap; TopoDS_Face EndCap; };
LoftBuildResult BuildLoft(const std::vector<LoftProfile>& profiles,const FeatureNode& feature);
LoftBuildResult BuildMultiLoopLoft(const std::vector<LoftProfile>& profiles,const FeatureNode& feature);
TopoDS_Shape BuildLegacyLoft(const std::vector<TopoDS_Shape>& sections,double spacing);
bool IsProfileLoft(const FeatureNode& feature);
LoftProfile ResolveLoftProfile(const TopoDS_Shape& shape,const TopologyNames& names,const JsonValue& reference);
}
