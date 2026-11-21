#include "CadDocument.hxx"
#include "BodyDisplayMetadata.hxx"

#include "CadError.hxx"
#include "TopologyHistory.hxx"
#include "../features/BooleanBuilder.hxx"
#include "../presentation/ShapeSerializer.hxx"

#include <BOPAlgo_Splitter.hxx>
#include <BRepAlgoAPI_Common.hxx>
#include <BRepAlgoAPI_Cut.hxx>
#include <BRepAlgoAPI_Fuse.hxx>
#include <BRepAlgoAPI_Section.hxx>
#include <BRepTools_History.hxx>
#include <BRepCheck_Analyzer.hxx>
#include <ShapeUpgrade_UnifySameDomain.hxx>
#include <TopAbs_ShapeEnum.hxx>
#include <TopExp_Explorer.hxx>
#include <TopoDS.hxx>

#include <algorithm>
#include <set>
#include <sstream>
#include <vector>

namespace
{
std::vector<std::string> bodyIds(const occweb::JsonValue& inputs,
                                 const std::string& pluralKey,
                                 const std::string& singularKey)
{
  std::vector<std::string> result;
  if (const occweb::JsonValue* values = inputs.Find(pluralKey))
  {
    if (!values->IsArray())
      throw occweb::CadError("INVALID_BOOLEAN_INPUT", pluralKey + " must be an array.");
    for (const occweb::JsonValue& value : values->AsArray())
    {
      if (!value.IsString() || value.AsString().empty())
        throw occweb::CadError("INVALID_BOOLEAN_INPUT", pluralKey + " must contain Body ids.");
      result.push_back(value.AsString());
    }
  }
  else
  {
    const std::string value = inputs.GetStringOr(singularKey, "");
    if (!value.empty()) result.push_back(value);
  }
  std::sort(result.begin(), result.end());
  result.erase(std::unique(result.begin(), result.end()), result.end());
  return result;
}

std::string join(const std::vector<std::string>& values)
{
  std::ostringstream output;
  for (std::size_t index = 0; index < values.size(); ++index)
  {
    if (index != 0) output << ',';
    output << values[index];
  }
  return output.str();
}


std::vector<TopoDS_Shape> resultShapes(const TopoDS_Shape& result, const bool splitResults)
{
  if (!splitResults) return {result};
  std::vector<TopoDS_Shape> solids;
  for (TopExp_Explorer explorer(result, TopAbs_SOLID); explorer.More(); explorer.Next())
    solids.push_back(explorer.Current());
  return solids.size() > 1 ? solids : std::vector<TopoDS_Shape>{result};
}
}

namespace occweb
{
std::string CadDocument::Boolean(const std::string& requestId, const int expectedRevision,
                                 const std::string& operation, const JsonValue& inputs,
                                 const JsonValue& parameters)
{
  if (expectedRevision != myRevision)
    throw CadError("STALE_REVISION", "Document revision is stale. Reload before applying Boolean.");

  const std::vector<std::string> targetIds = bodyIds(inputs, "targetBodies", "targetBody");
  const std::vector<std::string> toolIds = bodyIds(inputs, "toolBodies", "toolBody");
  if (targetIds.empty() || toolIds.empty())
    throw CadError("INVALID_BOOLEAN_INPUT", "Boolean requires at least one Target and one Tool Body.");
  for (const std::string& id : targetIds)
    if (std::find(toolIds.begin(), toolIds.end(), id) != toolIds.end())
      throw CadError("INVALID_BOOLEAN_INPUT", "A Body cannot be both Target and Tool.");

  const bool keepTarget = parameters.GetBooleanOr("keepTarget", false);
  bool keepTool = parameters.GetBooleanOr("keepTool", false);
  const bool refine = parameters.GetBooleanOr("refine", true);
  const bool splitResult = parameters.GetBooleanOr("splitResults", false);
  if (operation == "boolean.imprint") keepTool = true;

  std::vector<TopoDS_Shape> targets;
  std::vector<TopoDS_Shape> tools;
  std::vector<std::string> inputFeatures;
  for (const std::string& id : targetIds)
  {
    const BodyRecord& body = bodyOrActive(id);
    targets.push_back(body.Shape);
    inputFeatures.push_back(body.SourceFeatureId);
  }
  for (const std::string& id : toolIds)
  {
    const BodyRecord& body = bodyOrActive(id);
    tools.push_back(body.Shape);
    inputFeatures.push_back(body.SourceFeatureId);
  }

  const auto built=BuildBooleanOperation(operation,targets,tools,refine);
  const auto& topologyHistory=built.History;
  const auto& result=built.Shape;

  const int nextRevision = myRevision + 1;
  const BodyRecord templateBody = bodyOrActive(targetIds.front());
  const std::vector<TopoDS_Shape> outputs = resultShapes(result, splitResult);
  std::vector<std::string> outputIds;
  std::vector<BodyRecord> outputBodies;
  for (std::size_t index = 0; index < outputs.size(); ++index)
  {
    BodyRecord output = templateBody;
    const bool reuseTarget = !keepTarget && index == 0;
    output.Id = reuseTarget ? targetIds.front() : nextBodyId();
    output.Shape = outputs[index];
    output.Names.clear();
    output.Kind = BodyKindFromShape(output.Shape);
    output.TopologyRevision = nextRevision;
    output.Name = templateBody.Name + (outputs.size() > 1 ? " Result " + std::to_string(index + 1) : " Result");
    if (!reuseTarget) output.Label = myShapeTool->AddShape(output.Shape, false, false);
    outputIds.push_back(output.Id);
    outputBodies.push_back(output);
  }

  FeatureNode feature;
  feature.Id = nextFeatureId();
  feature.Type = operation;
  feature.ComputedRevision = nextRevision;
  feature.InputFeatures = inputFeatures;
  feature.OutputBodies = outputIds;
  feature.StringParameters["targetBody"] = targetIds.front();
  feature.StringParameters["toolBody"] = toolIds.front();
  feature.StringParameters["targetBodies"] = join(targetIds);
  feature.StringParameters["toolBodies"] = join(toolIds);
  feature.StringParameters["keepTarget"] = keepTarget ? "true" : "false";
  feature.StringParameters["keepTool"] = keepTool ? "true" : "false";
  feature.StringParameters["refine"] = refine ? "true" : "false";
  feature.StringParameters["splitResults"] = splitResult ? "true" : "false";
  const auto storeBodyMetadata = [&](const std::string& role, const BodyRecord& body)
  {
    StoreBodyDisplayMetadata(feature,role,body);
  };
  for (const std::string& id : targetIds) storeBodyMetadata("inputBodyMeta", bodyOrActive(id));
  for (const std::string& id : toolIds) storeBodyMetadata("inputBodyMeta", bodyOrActive(id));
  for (const BodyRecord& output : outputBodies) storeBodyMetadata("outputBodyMeta", output);
  for (BodyRecord& output : outputBodies) output.SourceFeatureId = feature.Id;
  feature.TopologyLineageRevision = nextRevision;

  const auto propagate = [&](const std::vector<std::string>& inputIds, const bool keepInput)
  {
    for (const std::string& id : inputIds)
    {
      const BodyRecord& old = bodyOrActive(id);
      ShapeSerializer oldTopology(old.Shape, old.TopologyRevision, old.Id);
      std::map<std::string, TopologyRemap> destinations;
      std::map<std::string, TopologyLineageEntry> lineage;
      for (BodyRecord& output : outputBodies)
      {
        TopologyNaming::Merge(output.Names,TopologyNaming::Propagate(old.Shape,old.Names,output.Shape,*topologyHistory));
        ShapeSerializer outputTopology(output.Shape, nextRevision, output.Id);
        const TopologyRemap mapping = TopologyHistory::Build(oldTopology, outputTopology,
          old.TopologyRevision, nextRevision, *topologyHistory);
        destinations.emplace(output.Id, mapping);
        for (const auto& [sourceId, targetIds] : mapping)
        {
          TopologyLineageEntry& entry = lineage[sourceId];
          entry.SourceBodyId = old.Id; entry.SourceTopologyId = sourceId;
          entry.SourceRevision = old.TopologyRevision; entry.InputPreserved = keepInput;
          for (const std::string& targetId : targetIds) entry.Destinations.push_back({output.Id, targetId});
        }
        if (std::find(targetIds.begin(), targetIds.end(), old.Id) != targetIds.end())
          myProperties.CopyBodyProperties(old.Id, output.Id, operation + ": inherited Target Body properties");
      }
      myProperties.RemapTopologyToBodies(old.Id, destinations, keepInput, operation);
      for (auto& [unused, entry] : lineage) feature.TopologyLineage.push_back(std::move(entry));
    }
  };
  propagate(targetIds, keepTarget);
  propagate(toolIds, keepTool);
  for(auto& output:outputBodies)TopologyNaming::CompleteEdges(output.Shape,output.Names);

  std::set<std::string> consumed;
  if (!keepTarget) consumed.insert(targetIds.begin(), targetIds.end());
  if (!keepTool) consumed.insert(toolIds.begin(), toolIds.end());
  for (const std::string& id : consumed)
  {
    if (id == outputIds.front()) continue;
    const auto found = myBodies.find(id);
    if (found != myBodies.end())
    {
      myProperties.OrphanBody(id, operation + " consumed the input body");
      myShapeTool->RemoveShape(found->second.Label, true);
      myBodies.erase(found);
    }
  }
  for (BodyRecord& output : outputBodies)
  {
    const auto existing = myBodies.find(output.Id);
    if (existing != myBodies.end())
    {
      output.Label = existing->second.Label;
      myShapeTool->SetShape(output.Label, output.Shape);
      existing->second = output;
    }
    else myBodies.emplace(output.Id, output);
  }

  myRevision = nextRevision;
  myActiveBodyId = outputIds.front();
  myFeatures.push_back(feature);
  persistMetadata();
  return ShapeSerializer(outputBodies.front().Shape, myRevision, outputIds.front())
    .Serialize(responsePrefix(requestId));
}
}
