#pragma once
#include "TopologyNaming.hxx"

namespace occweb
{
struct FeatureNode;
std::string SuspendedDefinitionFingerprint(const FeatureNode& feature,const std::string& identityOverride={});
std::string StableSuspendedDefinitionFingerprint(const FeatureNode& feature,const std::string& identityOverride={});
struct SuspendedTopologyIdentity
{
  std::string BodyId,BodyIdentity,TopologyIdentity,SourceFeatureId,SourceFeatureIdentity;
  int Revision=0;
  std::string DefinitionFingerprint;
  int DefinitionVersion=1;
  std::string StableDefinitionFingerprint;
};
struct SuspendedTopologyResolution
{
  bool Verified=false;
  SuspendedTopologyIdentity Source;
  TopologyRemap Mapping;
};
SuspendedTopologyIdentity InspectSuspendedTopology(const std::string& proof);
std::string CaptureSuspendedTopology(const TopoDS_Shape& shape,const TopologyNames& names,
                                     const SuspendedTopologyIdentity& identity);
SuspendedTopologyResolution ResolveSuspendedTopology(const TopoDS_Shape& shape,const TopologyNames& names,
  const std::string& proof,const SuspendedTopologyIdentity& current,int resultRevision);
// Only exact old evidence can be re-certified. The old envelope is retained as
// an audit record, never used as a second, weaker geometric matching route.
std::string RecertifySuspendedTopology(const std::string& proof,
  const TopoDS_Shape& before,const TopologyNames& beforeNames,
  const TopoDS_Shape& after,const TopologyNames& afterNames,
  const FeatureNode& oldDefinition,const FeatureNode& newDefinition,
  const std::string& bodyId,const std::string& bodyIdentity,int currentRevision);
}
