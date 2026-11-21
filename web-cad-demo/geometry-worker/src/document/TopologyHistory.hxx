#pragma once

#include <map>
#include <set>
#include <string>
#include <vector>

class BRepBuilderAPI_MakeShape;
class BRepTools_History;

namespace occweb
{
class ShapeSerializer;

using TopologyRemap = std::map<std::string, std::vector<std::string>>;

class TopologyHistory
{
public:
  static TopologyRemap Build(ShapeSerializer& oldTopology, ShapeSerializer& newTopology,
                             int oldRevision, int newRevision,
                             BRepBuilderAPI_MakeShape& history,
                             const std::set<std::string>& forceDeleted = {});
  static TopologyRemap MapByIndex(ShapeSerializer& oldTopology, ShapeSerializer& newTopology,
                                  int oldRevision, int newRevision);
  static TopologyRemap Build(ShapeSerializer& oldTopology, ShapeSerializer& newTopology,
                             int oldRevision, int newRevision, const BRepTools_History& history);
};
}
