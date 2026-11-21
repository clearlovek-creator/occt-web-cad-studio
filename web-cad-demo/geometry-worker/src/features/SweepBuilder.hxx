#pragma once
#include "FeatureNode.hxx"
#include "../document/TopologyNaming.hxx"
#include "../document/CadError.hxx"
#include <TopoDS_Edge.hxx>
#include <TopoDS_Face.hxx>

namespace occweb
{
struct SweepProfile {TopoDS_Face Face;TopologyNames Names;std::string Proof;};
struct SweepPath {std::vector<TopoDS_Edge> Edges;std::string Proof;};
struct CurveSweepResult {TopoDS_Shape Shape;TopologyNames Names;};
struct SweepInputSlot {std::string Id;std::string Field;std::string Kind;int EdgeIndex=-1;};
bool IsCurveSweep(const FeatureNode& feature);
std::vector<SweepInputSlot> CurveSweepInputs(const FeatureNode& feature);
void StoreCurveSweepReference(FeatureNode& feature,const std::string& field,const JsonValue& reference);
CadError CurveSweepInputFailure(const std::string& featureId,const std::string& inputId,const std::string& kind,const std::string& reason);
SweepProfile ResolveSweepProfile(const TopoDS_Shape& shape,const TopologyNames& names,const JsonValue& reference);
SweepPath ResolveSweepPath(const TopoDS_Shape& shape,const TopologyNames& names,const JsonValue& reference,const std::string& featureId="");
CurveSweepResult BuildCurveSweep(const SweepProfile& profile,const SweepPath& path,const FeatureNode& feature);
}
