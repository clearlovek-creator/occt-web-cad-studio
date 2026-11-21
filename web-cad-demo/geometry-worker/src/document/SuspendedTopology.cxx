#include "SuspendedTopology.hxx"
#include "CadError.hxx"
#include "ShapeFingerprint.hxx"
#include "../features/FeatureNode.hxx"
#include "../protocol/Json.hxx"

namespace occweb
{
namespace {
constexpr std::size_t MaxProofBytes=17u*1024u*1024u;
JsonValue readProof(const std::string& serialized){
  if(serialized.size()>MaxProofBytes)throw JsonError("Recovery proof exceeds the supported size.");
  auto proof=JsonParser(serialized).Parse();const int version=proof.GetInteger("version");
  if(version!=1 && version!=2)throw JsonError("Unsupported recovery proof version.");
  if(proof.Has("priorNamingProof") || proof.Has("priorNamingProofSha256") || proof.Has("namingUpgradeBasis")){
    if(version!=2 || !proof.Has("priorNamingProof") || !proof.At("priorNamingProof").IsObject() || proof.GetString("namingUpgradeBasis")!="exact-archived-output-v1"
        || StableDigest(JsonSerialize(proof.At("priorNamingProof")))!=proof.GetString("priorNamingProofSha256"))
      throw JsonError("Archived naming migration audit evidence is invalid.");
  }
  return proof;
}
SuspendedTopologyIdentity proofIdentity(const JsonValue& proof){
  SuspendedTopologyIdentity source{proof.GetString("bodyId"),proof.GetString("bodyIdentity"),proof.GetString("topologyIdentity"),
    proof.GetString("sourceFeatureId"),proof.GetString("sourceFeatureIdentity"),proof.GetInteger("revision"),proof.GetString("definitionFingerprint")};
  source.DefinitionVersion=proof.GetInteger("version");
  if(source.BodyId.empty() || source.BodyIdentity.empty() || source.TopologyIdentity.empty() || source.SourceFeatureId.empty()
      || source.SourceFeatureIdentity.empty() || source.Revision<0 || source.DefinitionFingerprint.size()!=64
      || source.DefinitionFingerprint.find_first_not_of("0123456789abcdef")!=std::string::npos)
    throw JsonError("Recovery ownership evidence is incomplete.");
  return source;
}
}
SuspendedTopologyIdentity InspectSuspendedTopology(const std::string& serialized)
{
  try{return proofIdentity(readProof(serialized));}
  catch(const JsonError& error){throw CadError("INVALID_SUSPENDED_TOPOLOGY",error.what());}
}
std::string SuspendedDefinitionFingerprint(const FeatureNode& feature,const std::string& identityOverride)
{
  // Do not copy bulk proofs or accumulated evolution history just to discard
  // them: a Pattern may own many independent output recovery records.
  FeatureNode definition;definition.Id=feature.Id;definition.Type=feature.Type;
  definition.Identity=identityOverride.empty()?feature.Identity:identityOverride;
  definition.State="";definition.InputFeatures=feature.InputFeatures;definition.OutputBodies=feature.OutputBodies;
  definition.NumberParameters=feature.NumberParameters;
  for(const auto& [key,value]:feature.StringParameters){
    if(key.rfind("outputBodyMeta.",0)!=0 && key.rfind("inputBodyMeta.",0)!=0 && key.rfind("lifecycleBodyMeta.",0)!=0)
      definition.StringParameters.emplace(key,value);
  }
  return StableDigest(definition.ToJson());
}
std::string StableSuspendedDefinitionFingerprint(const FeatureNode& feature,const std::string& identityOverride)
{
  FeatureNode stable;stable.Id=feature.Id;stable.Type=feature.Type;stable.Identity=feature.Identity;
  stable.InputFeatures=feature.InputFeatures;stable.OutputBodies=feature.OutputBodies;
  stable.NumberParameters=feature.NumberParameters;
  for(const auto& [key,value]:feature.StringParameters){
    // Replaying a persistent selector changes only its temporary display ID.
    // Keep the actual selector, source and parameters in the digest.
    if((key=="faceId" || key=="edgeId") && feature.StringParameters.count("selection."+key))continue;
    if(key.rfind("outputBodyMeta.",0)!=0 && key.rfind("inputBodyMeta.",0)!=0 && key.rfind("lifecycleBodyMeta.",0)!=0)
      stable.StringParameters.emplace(key,value);
  }
  return StableDigest("suspended-definition-v2/"+SuspendedDefinitionFingerprint(stable,identityOverride));
}
std::string CaptureSuspendedTopology(const TopoDS_Shape& shape,const TopologyNames& names,
                                     const SuspendedTopologyIdentity& identity)
{
  if((identity.DefinitionVersion!=1 && identity.DefinitionVersion!=2) || identity.BodyId.empty() || identity.BodyIdentity.empty() || identity.TopologyIdentity.empty()
     || identity.SourceFeatureId.empty() || identity.SourceFeatureIdentity.empty() || identity.Revision<0 || identity.DefinitionFingerprint.size()!=64)
    throw CadError("INVALID_SUSPENDED_TOPOLOGY","Cannot capture recovery evidence without persistent ownership identities.");
  JsonValue proof=JsonValue::MakeObject();
  proof.ChangeObject()["version"]=JsonValue(double(identity.DefinitionVersion));
  proof.ChangeObject()["bodyId"]=JsonValue(identity.BodyId);
  proof.ChangeObject()["bodyIdentity"]=JsonValue(identity.BodyIdentity);
  proof.ChangeObject()["topologyIdentity"]=JsonValue(identity.TopologyIdentity);
  proof.ChangeObject()["sourceFeatureId"]=JsonValue(identity.SourceFeatureId);
  proof.ChangeObject()["sourceFeatureIdentity"]=JsonValue(identity.SourceFeatureIdentity);
  proof.ChangeObject()["revision"]=JsonValue(double(identity.Revision));
  proof.ChangeObject()["definitionFingerprint"]=JsonValue(identity.DefinitionFingerprint);
  proof.ChangeObject()["selectionSet"]=TopologyNaming::CaptureSelectionSet(shape,names);
  return JsonSerialize(proof);
}

SuspendedTopologyResolution ResolveSuspendedTopology(const TopoDS_Shape& shape,const TopologyNames& names,
  const std::string& serialized,const SuspendedTopologyIdentity& current,int resultRevision)
{
  try{
    const auto proof=readProof(serialized);
    SuspendedTopologyResolution result;
    result.Source=proofIdentity(proof);
    const auto& source=result.Source;
    if(source.BodyId.empty() || source.BodyIdentity.empty() || source.TopologyIdentity.empty()
       || source.SourceFeatureId.empty() || source.SourceFeatureIdentity.empty() || source.Revision<0 || source.DefinitionFingerprint.size()!=64)
      throw JsonError("Recovery ownership evidence is incomplete.");
    if(source.BodyId!=current.BodyId || source.BodyIdentity!=current.BodyIdentity
       || source.SourceFeatureId!=current.SourceFeatureId || source.SourceFeatureIdentity!=current.SourceFeatureIdentity)
      return result; // A reused display ID must not resurrect another object's properties.
    const auto expected=source.DefinitionVersion==2&&!current.StableDefinitionFingerprint.empty()?current.StableDefinitionFingerprint:current.DefinitionFingerprint;
    result.Mapping=TopologyNaming::ResolveSelectionSet(shape,names,proof.At("selectionSet"),source.Revision,resultRevision,
      source.DefinitionFingerprint==expected);
    result.Verified=true;
    return result;
  }catch(const JsonError& error){throw CadError("INVALID_SUSPENDED_TOPOLOGY",error.what());}
}

std::string RecertifySuspendedTopology(const std::string& serialized,
  const TopoDS_Shape& before,const TopologyNames& beforeNames,const TopoDS_Shape& after,const TopologyNames& afterNames,
  const FeatureNode& oldDefinition,const FeatureNode& newDefinition,const std::string& bodyId,const std::string& bodyIdentity,const int currentRevision)
{
  try{
    const auto proof=readProof(serialized);auto identity=proofIdentity(proof);
    const auto oldDigest=identity.DefinitionVersion==2?StableSuspendedDefinitionFingerprint(oldDefinition):SuspendedDefinitionFingerprint(oldDefinition);
    if(identity.BodyId!=bodyId || identity.BodyIdentity!=bodyIdentity || identity.SourceFeatureId!=oldDefinition.Id
        || identity.SourceFeatureIdentity!=oldDefinition.Identity || oldDefinition.Id!=newDefinition.Id || oldDefinition.Identity!=newDefinition.Identity
        || identity.Revision>currentRevision || identity.DefinitionFingerprint!=oldDigest)
      throw CadError("IMPORT_NAMING_UPGRADE_ARCHIVE_UNVERIFIED","Archived source ownership or generating definition no longer matches its captured evidence.");
    // Exact geometry alone cannot replace the original provenance set.
    auto originalSet=TopologyNaming::CaptureSelectionSet(before,beforeNames);
    // Optional remote context did not exist in old v1 archives. Compare their
    // original evidence exactly, without inventing retroactive source proof.
    // If an archive did retain the extension, it must match the exact output.
    for(auto& [id,entry]:originalSet.ChangeObject().at("entries").ChangeObject()){
      const auto archived=proof.At("selectionSet").At("entries").Find(id);
      if(archived&&!archived->Has("remoteContext"))entry.ChangeObject().erase("remoteContext");
    }
    if(ShapeFingerprint(before)!=ShapeFingerprint(after) || JsonSerialize(originalSet)!=JsonSerialize(proof.At("selectionSet")))
      throw CadError("IMPORT_NAMING_UPGRADE_ARCHIVE_UNVERIFIED","The restored archived output differs from its original exact BRep or topology evidence.");
    const auto checked=ResolveSuspendedTopology(before,beforeNames,serialized,
      {bodyId,bodyIdentity,"",oldDefinition.Id,oldDefinition.Identity,0,SuspendedDefinitionFingerprint(oldDefinition),1,StableSuspendedDefinitionFingerprint(oldDefinition)},currentRevision+1);
    if(!checked.Verified)throw CadError("IMPORT_NAMING_UPGRADE_ARCHIVE_UNVERIFIED","Archived ownership could not be verified.");
    for(const auto& [unused,targets]:checked.Mapping)if(targets.size()!=1)
      throw CadError("IMPORT_NAMING_UPGRADE_ARCHIVE_UNVERIFIED","Archived topology is not completely proven; no partial re-certification was applied.");
    identity.DefinitionVersion=2;identity.DefinitionFingerprint=StableSuspendedDefinitionFingerprint(newDefinition);
    auto migrated=JsonParser(CaptureSuspendedTopology(after,afterNames,identity)).Parse();
    migrated.ChangeObject()["priorNamingProof"]=proof;
    migrated.ChangeObject()["priorNamingProofSha256"]=JsonValue(StableDigest(JsonSerialize(proof)));
    migrated.ChangeObject()["namingUpgradeBasis"]=JsonValue(std::string("exact-archived-output-v1"));
    const auto result=JsonSerialize(migrated);
    if(result.size()>MaxProofBytes)throw CadError("IMPORT_NAMING_UPGRADE_ARCHIVE_LIMIT","Re-certified evidence and retained original exceed the 17 MiB per-proof budget.");
    return result;
  }catch(const JsonError& error){throw CadError("INVALID_SUSPENDED_TOPOLOGY",error.what());}
}
}
