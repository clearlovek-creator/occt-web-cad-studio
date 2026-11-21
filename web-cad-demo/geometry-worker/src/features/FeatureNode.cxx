#include "FeatureNode.hxx"

#include <iomanip>
#include <sstream>

namespace
{
void writeEntries(std::ostream& out,const std::vector<occweb::TopologyLineageEntry>& entries)
{
  out<<'[';bool first=true;for(const auto& entry:entries){if(!first)out<<',';first=false;
    out<<"{\"sourceBodyId\":\""<<occweb::JsonEscape(entry.SourceBodyId)<<"\",\"sourceTopologyId\":\""<<occweb::JsonEscape(entry.SourceTopologyId)<<"\",\"sourceRevision\":"<<entry.SourceRevision<<",\"inputPreserved\":"<<(entry.InputPreserved?"true":"false");
    if(!entry.State.empty())out<<",\"state\":\""<<occweb::JsonEscape(entry.State)<<"\",\"resultRevision\":"<<entry.ResultRevision;
    out<<",\"sourceBodyIdentity\":\""<<occweb::JsonEscape(entry.SourceBodyIdentity)<<"\",\"sourceTopologyIdentity\":\""<<occweb::JsonEscape(entry.SourceTopologyIdentity)<<"\",\"destinations\":[";for(std::size_t i=0;i<entry.Destinations.size();i++){if(i)out<<',';out<<"{\"bodyId\":\""<<occweb::JsonEscape(entry.Destinations[i].BodyId)<<"\",\"topologyId\":\""<<occweb::JsonEscape(entry.Destinations[i].TopologyId)<<"\",\"bodyIdentity\":\""<<occweb::JsonEscape(entry.Destinations[i].BodyIdentity)<<"\",\"topologyIdentity\":\""<<occweb::JsonEscape(entry.Destinations[i].TopologyIdentity)<<"\"}";}out<<"]}";
  }out<<']';
}
occweb::TopologyLineageEntry readEntry(const occweb::JsonValue& item)
{
  occweb::TopologyLineageEntry entry;entry.SourceBodyId=item.GetString("sourceBodyId");entry.SourceTopologyId=item.GetString("sourceTopologyId");entry.SourceRevision=item.GetIntegerOr("sourceRevision",0);entry.InputPreserved=item.GetBooleanOr("inputPreserved",false);entry.State=item.GetStringOr("state","");entry.ResultRevision=item.GetIntegerOr("resultRevision",0);
  entry.SourceBodyIdentity=item.GetStringOr("sourceBodyIdentity","");entry.SourceTopologyIdentity=item.GetStringOr("sourceTopologyIdentity","");
  for(const auto& target:item.At("destinations").AsArray())entry.Destinations.push_back({target.GetString("bodyId"),target.GetString("topologyId"),target.GetStringOr("bodyIdentity",""),target.GetStringOr("topologyIdentity","")});return entry;
}
}

namespace occweb
{
void FeatureNode::RecordTopologyLineage(const std::string& sourceBody,int sourceRevision,const std::string& destinationBody,
  int resultRevision,const std::map<std::string,std::vector<std::string>>& remap,bool preserve)
{
  TopologyLineageRevision=resultRevision;
  for(const auto& [source,targets]:remap){TopologyLineageEntry entry;entry.SourceBodyId=sourceBody;entry.SourceTopologyId=source;entry.SourceRevision=sourceRevision;entry.InputPreserved=preserve;for(const auto& target:targets)entry.Destinations.push_back({destinationBody,target});TopologyLineage.push_back(std::move(entry));}
}
std::string FeatureNode::ToJson(bool includeInternal) const
{
  std::ostringstream output;
  output << std::setprecision(17)
         << "{\"id\":\"" << JsonEscape(Id)
         << "\",\"type\":\"" << JsonEscape(Type)
         << "\",\"state\":\"" << JsonEscape(State)
         << "\",\"computedRevision\":" << ComputedRevision;
  if (!Identity.empty()) output << ",\"identity\":\"" << JsonEscape(Identity) << '"';

  output << ",\"inputFeatures\":[";
  for (std::size_t index = 0; index < InputFeatures.size(); ++index)
  {
    if (index > 0) output << ',';
    output << '"' << JsonEscape(InputFeatures[index]) << '"';
  }
  output << ']';

  output << ",\"outputBodies\":[";
  for (std::size_t index = 0; index < OutputBodies.size(); ++index)
  {
    if (index > 0) output << ',';
    output << '"' << JsonEscape(OutputBodies[index]) << '"';
  }
  output << ']';

  output << ",\"numberParameters\":{";
  bool first = true;
  for (const auto& [key, value] : NumberParameters)
  {
    if (!first) output << ',';
    output << '"' << JsonEscape(key) << "\":" << value;
    first = false;
  }
  output << '}';

  output << ",\"stringParameters\":{";
  first = true;
  for (const auto& [key, value] : StringParameters)
  {
    if (!first) output << ',';
    output << '"' << JsonEscape(key) << "\":\"" << JsonEscape(value) << '"';
    first = false;
  }
  output << '}';
  if (TopologyLineageRevision > 0)
  {
    output << ",\"topologyLineage\":{\"version\":1,\"basis\":\"occt-history\",\"resultRevision\":"
           << TopologyLineageRevision << ",\"state\":\""
           << (TopologyLineageRevision == ComputedRevision ? "current" : "stale") << "\",\"entries\":";
    writeEntries(output,TopologyLineage);
    output << '}';
  }
  if(!TopologyEvolutions.empty()) {output<<",\"topologyEvolutions\":{\"version\":1,\"basis\":\"semantic-topology-v1\",\"entries\":";writeEntries(output,TopologyEvolutions);output<<'}';}
  if(includeInternal && !SuspendedTopology.empty()){
    output<<",\"suspendedTopology\":{";bool first=true;for(const auto& [body,proof]:SuspendedTopology){if(!first)output<<',';first=false;output<<'"'<<JsonEscape(body)<<"\":"<<proof;}output<<'}';
  }
  output << '}';
  return output.str();
}

FeatureNode FeatureNode::FromJson(const JsonValue& value)
{
  FeatureNode feature;
  feature.Id = value.GetString("id");
  feature.Type = value.GetString("type");
  feature.Identity = value.GetStringOr("identity", "");
  feature.State = value.GetStringOr("state", "valid");
  feature.ComputedRevision = value.GetIntegerOr("computedRevision", 0);

  if (const JsonValue* inputs = value.Find("inputFeatures"))
  {
    for (const JsonValue& input : inputs->AsArray()) feature.InputFeatures.push_back(input.AsString());
  }
  if (const JsonValue* outputs = value.Find("outputBodies"))
  {
    for (const JsonValue& body : outputs->AsArray()) feature.OutputBodies.push_back(body.AsString());
  }
  if (const JsonValue* numbers = value.Find("numberParameters"))
  {
    for (const auto& [key, number] : numbers->AsObject())
    {
      feature.NumberParameters.emplace(key, number.AsNumber());
    }
  }
  if (const JsonValue* strings = value.Find("stringParameters"))
  {
    for (const auto& [key, string] : strings->AsObject())
    {
      feature.StringParameters.emplace(key, string.AsString());
    }
  }
  if (const JsonValue* lineage = value.Find("topologyLineage"))
  {
    feature.TopologyLineageRevision = lineage->GetIntegerOr("resultRevision", 0);
    if (const JsonValue* entries = lineage->Find("entries"))
      for (const JsonValue& item : entries->AsArray())
      {
        feature.TopologyLineage.push_back(readEntry(item));
      }
  }
  if(const auto* evolutions=value.Find("topologyEvolutions"))for(const auto& item:evolutions->At("entries").AsArray())feature.TopologyEvolutions.push_back(readEntry(item));
  if(const auto* suspended=value.Find("suspendedTopology"))for(const auto& [body,proof]:suspended->AsObject())feature.SuspendedTopology.emplace(body,JsonSerialize(proof));
  return feature;
}
}
