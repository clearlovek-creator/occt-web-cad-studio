#pragma once
#include "TopologyHistory.hxx"
#include <TopoDS_Shape.hxx>
#include <map>
#include <cstddef>
#include <string>
#include <utility>
#include <vector>

class BRepTools_History;
class BRepBuilderAPI_MakeShape;
namespace occweb
{
class JsonValue;
using TopologyNames = std::map<std::string, std::vector<std::string>>;
using NamedSubshapes = std::vector<std::pair<TopoDS_Shape, std::string>>;
struct NamedTopologyBody { TopoDS_Shape Shape; TopologyNames Names; int Revision; std::string Context; };
using BodyTopologyRemaps = std::map<std::string,std::map<std::string,TopologyRemap>>;

class TopologyNaming
{
public:
  static TopologyNames Seed(const TopoDS_Shape& shape, const std::string& featureId, const NamedSubshapes& roles);
  // Immutable external geometry has no constructor roles. Bind exact source
  // topology to its file fingerprint, whole part and distinct output occurrence.
  // This does not match changed source files by index or geometric proximity.
  static TopologyNames ImportedSource(const TopoDS_Shape& shape, const std::string& featureId,
                                     const std::string& outputBodyId, const std::string& sourceFingerprint);
  static TopologyNames Propagate(const TopoDS_Shape& before, const TopologyNames& names,
                                 const TopoDS_Shape& after, const BRepTools_History& history);
  static TopologyNames Propagate(const TopoDS_Shape& before, const TopologyNames& names,
                                 const TopoDS_Shape& after, BRepBuilderAPI_MakeShape& builder);
  static TopologyNames FeatureResult(const TopoDS_Shape& before, const TopologyNames& names,
                                     const TopoDS_Shape& after, BRepBuilderAPI_MakeShape& builder,
                                     const std::string& featureId,
                                     const std::vector<TopoDS_Shape>& consumedFaces = {});
  static TopologyNames Restrict(const TopoDS_Shape& before, const TopologyNames& names,
                                const TopoDS_Shape& subshape);
  static TopologyNames SweepResult(const TopoDS_Shape& profile, const TopologyNames& names,
                                   const TopoDS_Shape& after, BRepBuilderAPI_MakeShape& builder,
                                   const std::string& featureId,
                                   const TopoDS_Shape& first, const TopoDS_Shape& last);
  static TopologyNames Instance(const TopologyNames& names, const std::string& featureId,
                                const std::string& slot);
  static void Merge(TopologyNames& destination, const TopologyNames& source);
  static void CompleteEdges(const TopoDS_Shape& shape, TopologyNames& names);
  static BodyTopologyRemaps MatchBodies(const std::map<std::string,NamedTopologyBody>& before,
                                        const std::map<std::string,NamedTopologyBody>& after,
                                        std::size_t contextWorkLimit = 1000000);
  static std::string ToJson(const TopologyNames& names);
  static std::string CoverageJson(const TopologyNames& names);
  static TopologyNames FromJson(const JsonValue& value);
  static std::string CaptureSelection(const TopoDS_Shape& shape, const TopologyNames& names,
                                      const std::string& kind, int index,
                                      std::size_t contextWorkLimit = 1000000);
  static std::string SelectionProof(const TopoDS_Shape& shape,const TopologyNames& names,
                                     const std::string& kind,int index);
  static int ResolveSelection(const TopoDS_Shape& shape, const TopologyNames& names,
                              const std::string& selector,
                              std::size_t contextWorkLimit = 1000000);
  static JsonValue CaptureSelectionSet(const TopoDS_Shape& shape,const TopologyNames& names,
                                       std::size_t contextWorkLimit = 1000000);
  static TopologyRemap ResolveSelectionSet(const TopoDS_Shape& shape,const TopologyNames& names,
                                           const JsonValue& captured,int sourceRevision,int resultRevision,bool allowExact=true,
                                           std::size_t contextWorkLimit = 1000000);
};
}
