#pragma once

#include "../protocol/Json.hxx"

#include <map>
#include <string>
#include <vector>

namespace occweb
{
struct TopologyDestination
{
  std::string BodyId;
  std::string TopologyId;
  std::string BodyIdentity;
  std::string TopologyIdentity;
};
struct TopologyLineageEntry
{
  std::string SourceBodyId;
  std::string SourceTopologyId;
  std::string SourceBodyIdentity;
  std::string SourceTopologyIdentity;
  int SourceRevision = 0;
  bool InputPreserved = false;
  int ResultRevision = 0;
  std::string State;
  std::vector<TopologyDestination> Destinations;
};

struct FeatureNode
{
  std::string Id;
  std::string Type;
  std::string Identity;
  std::string State = "valid";
  int ComputedRevision = 0;
  std::vector<std::string> InputFeatures;
  std::vector<std::string> OutputBodies;
  std::map<std::string, double> NumberParameters;
  std::map<std::string, std::string> StringParameters;
  // Exact operation lineage, not a geometric similarity or enumeration match.
  // A later recompute invalidates this evidence until rebuilt by the operation.
  int TopologyLineageRevision = 0;
  std::vector<TopologyLineageEntry> TopologyLineage;
  std::vector<TopologyLineageEntry> TopologyEvolutions;
  // Private recovery evidence. Persist in XBF, never send bulk proofs to UI/AI.
  std::map<std::string,std::string> SuspendedTopology;

  std::string ToJson(bool includeInternal=false) const;
  static FeatureNode FromJson(const JsonValue& value);
  void RecordTopologyLineage(const std::string& sourceBody,int sourceRevision,const std::string& destinationBody,
    int resultRevision,const std::map<std::string,std::vector<std::string>>& remap,bool preserve=false);
};
}
