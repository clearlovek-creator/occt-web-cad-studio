#include "TopologyHistory.hxx"

#include "../presentation/ShapeSerializer.hxx"

#include <BRepBuilderAPI_MakeShape.hxx>
#include <BRepTools_History.hxx>
#include <NCollection_List.hxx>
#include <TopoDS_Shape.hxx>

#include <algorithm>

namespace
{
void appendUnique(std::vector<std::string>& values, const std::string& value)
{
  if (std::find(values.begin(), values.end(), value) == values.end()) values.push_back(value);
}

void collectResult(const TopoDS_Shape& result,
                   const NCollection_IndexedMap<TopoDS_Shape, TopTools_ShapeMapHasher>& newMap,
                   const std::string& prefix, std::vector<std::string>& target)
{
  const int index = newMap.FindIndex(result);
  if (index > 0) appendUnique(target, prefix + std::to_string(index));
}

template<class History>
void mapKind(const NCollection_IndexedMap<TopoDS_Shape, TopTools_ShapeMapHasher>& oldMap,
             const NCollection_IndexedMap<TopoDS_Shape, TopTools_ShapeMapHasher>& newMap,
             const std::string& kind, const int oldRevision, const int newRevision,
             History& history, const std::set<std::string>& forceDeleted,
             occweb::TopologyRemap& remap)
{
  const std::string oldPrefix = kind + '-' + std::to_string(oldRevision) + '-';
  const std::string newPrefix = kind + '-' + std::to_string(newRevision) + '-';
  for (int index = 1; index <= oldMap.Extent(); ++index)
  {
    const std::string oldId = oldPrefix + std::to_string(index);
    std::vector<std::string>& results = remap[oldId];
    if (forceDeleted.find(oldId) != forceDeleted.end()) continue;
    const TopoDS_Shape& oldShape = oldMap(index);
    // A retained physical subshape is the same entity, even when the builder
    // also reports a NEW offset skin as Generated(oldShape). Do not move its
    // properties to that new skin or make identity depend on history ordering.
    if (newMap.Contains(oldShape))
    {
      collectResult(oldShape,newMap,newPrefix,results);
      continue;
    }
    for (const TopoDS_Shape& shape : history.Modified(oldShape))
      collectResult(shape, newMap, newPrefix, results);
    for (const TopoDS_Shape& shape : history.Generated(oldShape))
      collectResult(shape, newMap, newPrefix, results);
    if (results.empty() && !history.IsDeleted(oldShape))
      collectResult(oldShape, newMap, newPrefix, results);
  }
}
}

namespace occweb
{
TopologyRemap TopologyHistory::Build(ShapeSerializer& oldTopology, ShapeSerializer& newTopology,
                                     const int oldRevision, const int newRevision,
                                     const BRepTools_History& history)
{
  struct HistoryAdapter
  {
    const BRepTools_History& History;
    const NCollection_List<TopoDS_Shape>& Modified(const TopoDS_Shape& shape) { return History.Modified(shape); }
    const NCollection_List<TopoDS_Shape>& Generated(const TopoDS_Shape& shape) { return History.Generated(shape); }
    bool IsDeleted(const TopoDS_Shape& shape) { return History.IsRemoved(shape); }
  } adapter{history};
  TopologyRemap remap;
  mapKind(oldTopology.Faces(), newTopology.Faces(), "face", oldRevision, newRevision, adapter, {}, remap);
  mapKind(oldTopology.Edges(), newTopology.Edges(), "edge", oldRevision, newRevision, adapter, {}, remap);
  return remap;
}

TopologyRemap TopologyHistory::Build(ShapeSerializer& oldTopology, ShapeSerializer& newTopology,
                                     const int oldRevision, const int newRevision,
                                     BRepBuilderAPI_MakeShape& history,
                                     const std::set<std::string>& forceDeleted)
{
  TopologyRemap remap;
  mapKind(oldTopology.Faces(), newTopology.Faces(), "face", oldRevision, newRevision,
          history, forceDeleted, remap);
  mapKind(oldTopology.Edges(), newTopology.Edges(), "edge", oldRevision, newRevision,
          history, forceDeleted, remap);
  return remap;
}
TopologyRemap TopologyHistory::MapByIndex(ShapeSerializer& oldTopology, ShapeSerializer& newTopology,
                                          const int oldRevision, const int newRevision)
{
  TopologyRemap remap;
  const auto mapKindByIndex = [&](const auto& oldMap, const auto& newMap, const std::string& kind)
  {
    const int shared = std::min(oldMap.Extent(), newMap.Extent());
    for (int index = 1; index <= oldMap.Extent(); ++index)
    {
      const std::string oldId = kind + '-' + std::to_string(oldRevision) + '-' + std::to_string(index);
      if (index <= shared)
        remap[oldId].push_back(kind + '-' + std::to_string(newRevision) + '-' + std::to_string(index));
      else
        remap[oldId];
    }
  };
  mapKindByIndex(oldTopology.Faces(), newTopology.Faces(), "face");
  mapKindByIndex(oldTopology.Edges(), newTopology.Edges(), "edge");
  return remap;
}
}
