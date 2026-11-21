#include "CadDocument.hxx"
#include "BodyDisplayMetadata.hxx"
#include "CadError.hxx"
#include "../features/LoftBuilder.hxx"
#include "../presentation/ShapeSerializer.hxx"
#include <algorithm>
#include <set>

namespace occweb
{
void CadDocument::configureLoft(FeatureNode& feature,const JsonValue& sections,const JsonValue& parameters)
{
  if(!sections.IsArray() || sections.AsArray().size()<2 || sections.AsArray().size()>32)
    throw CadError("INVALID_LOFT_SECTIONS","Provide 2 to 32 ordered sections, each with an explicit bodyId and faceId. Whole Solid bounds are not sections.");
  for(const auto& [key,unused]:parameters.AsObject())if(key!="placement" && key!="ruled" && key!="sectionSpacing")
    throw CadError("INVALID_PARAMETER","Unknown Loft definition field: "+key);
  const auto placement=parameters.GetStringOr("placement","actual");
  if(placement!="actual" && placement!="z-spacing")throw CadError("INVALID_PARAMETER","Loft placement must be actual or z-spacing.");
  if(placement=="actual" && parameters.Has("sectionSpacing"))throw CadError("INVALID_PARAMETER","sectionSpacing is only used by z-spacing placement; actual placement preserves the real section positions.");
  std::map<std::string,JsonValue> old;
  const bool existingProfileLoft=IsProfileLoft(feature);
  const auto previous=existingProfileLoft?JsonParser(feature.StringParameters.at("loftSections")).Parse():JsonValue::MakeArray();
  for(const auto& item:previous.AsArray())old.emplace(item.GetString("sectionId"),item);
  int next=feature.StringParameters.count("loftNextSection")?std::stoi(feature.StringParameters.at("loftNextSection")):1;
  if(next<1 || next>1000000)throw CadError("INVALID_FEATURE_GRAPH","Loft section identity counter is outside its supported range.");
  JsonValue references=JsonValue::MakeArray();std::set<std::string> used;feature.InputFeatures.clear();
  for(const auto& section:sections.AsArray()){
    JsonValue reference;
    if(section.Has("sectionId")){
      if(section.AsObject().size()!=1 || !old.count(section.GetString("sectionId")))throw CadError("INVALID_LOFT_SECTIONS","Unknown retained Loft section reference.");
      reference=old.at(section.GetString("sectionId"));
    }else{
      if(!section.IsObject() || section.AsObject().size()!=(section.Has("holeEdgeIds")?3:2) || !section.Has("bodyId") || !section.Has("faceId"))throw CadError("INVALID_LOFT_SECTIONS","New Loft sections require bodyId, faceId and optionally an ordered holeEdgeIds correspondence.");
      if(section.GetString("bodyId").empty() || section.GetString("faceId").empty())throw CadError("INVALID_LOFT_SECTIONS","Each Loft section must explicitly identify its Body and Face; the active Body is not used as a fallback.");
      const auto& body=bodyOrActive(section.GetString("bodyId"));ShapeSerializer topology(body.Shape,body.TopologyRevision,body.Id);
      const int index=topology.FaceIndexFromId(section.GetString("faceId"));if(index<1 || index>topology.Faces().Extent())throw CadError("FACE_NOT_FOUND","Loft section Face does not exist.");
      auto source=std::find_if(myFeatures.begin(),myFeatures.end(),[&](const auto& item){return item.Id==body.SourceFeatureId;});
      if(body.SourceFeatureId==feature.Id)throw CadError("LOFT_DEPENDENCY_CYCLE","A Loft cannot use its own output as a section. Select an independent source Face.");
      if(source==myFeatures.end())throw CadError("INVALID_FEATURE_GRAPH","Loft section has no source feature.");if(source->Identity.empty())source->Identity=newIdentity();
      reference=JsonValue::MakeObject();auto& fields=reference.ChangeObject();
      fields["sectionId"]=JsonValue("section-"+std::to_string(next++));fields["bodyId"]=JsonValue(body.Id);
      fields["bodyIdentity"]=JsonValue(myEntityIdentities.at(body.Id).Body);fields["featureId"]=JsonValue(source->Id);fields["featureIdentity"]=JsonValue(source->Identity);
      fields["selector"]=JsonValue(TopologyNaming::CaptureSelection(body.Shape,body.Names,"face",index));
      if(section.Has("holeEdgeIds")){
        const auto& seeds=section.At("holeEdgeIds");if(!seeds.IsArray() || seeds.AsArray().empty() || seeds.AsArray().size()>16)throw CadError("LOFT_HOLE_MAPPING_REQUIRED","Provide 1 to 16 ordered seed Edge IDs, one per hole of every section.");
        auto selectors=JsonValue::MakeArray();std::set<int> unique;
        for(const auto& seed:seeds.AsArray()){
          if(!seed.IsString())throw CadError("INVALID_LOFT_HOLE_MAPPING","A hole seed must be an explicit observed Edge ID.");
          const int edge=topology.EdgeIndexFromId(seed.AsString());
          if(edge<1 || edge>topology.Edges().Extent() || !unique.insert(edge).second)throw CadError("INVALID_LOFT_HOLE_MAPPING","Hole seed edges are missing or duplicated.");
          selectors.ChangeArray().push_back(JsonValue(TopologyNaming::CaptureSelection(body.Shape,body.Names,"edge",edge)));
        }
        fields["holeSelectors"]=selectors;
      }
    }
    if(!used.insert(reference.GetString("sectionId")).second)throw CadError("INVALID_LOFT_SECTIONS","The same section reference was listed twice.");
    const auto input=reference.GetString("featureId");if(std::find(feature.InputFeatures.begin(),feature.InputFeatures.end(),input)==feature.InputFeatures.end())feature.InputFeatures.push_back(input);
    references.ChangeArray().push_back(reference);
  }
  std::size_t holeCount=0;for(const auto& reference:references.AsArray())if(reference.Has("holeSelectors")){holeCount=reference.At("holeSelectors").AsArray().size();break;}
  if(holeCount)for(const auto& reference:references.AsArray())if(!reference.Has("holeSelectors") || reference.At("holeSelectors").AsArray().size()!=holeCount)throw CadError("LOFT_HOLE_MAPPING_REQUIRED","Every ordered section must explicitly map the same number of holes.");
  feature.StringParameters["loftVersion"]=holeCount?"3":"2";feature.StringParameters["loftSections"]=JsonSerialize(references);
  // Do not silently reinterpret caps saved by the initial v2 naming scheme.
  // New features and explicit v1 upgrades use endpoint-local cap identities.
  if(!existingProfileLoft || holeCount)feature.StringParameters["loftNamingVersion"]="2";
  feature.StringParameters["loftPlacement"]=placement;feature.StringParameters["loftRuled"]=parameters.GetBooleanOr("ruled",false)?"true":"false";
  feature.StringParameters["loftNextSection"]=std::to_string(next);
  feature.StringParameters.erase("sectionBodies");feature.NumberParameters.erase("sectionSpacing");feature.StringParameters.erase("expr.sectionSpacing");
  if(placement=="z-spacing")feature.NumberParameters["sectionSpacing"]=parameterValue(parameters,"sectionSpacing","length",10,false,&feature);
}
std::string CadDocument::Loft(const std::string& requestId,const int expectedRevision,const JsonValue& inputs,const JsonValue& parameters)
{
  if(expectedRevision!=myRevision)throw CadError("STALE_REVISION","Document revision is stale. Reload before creating a Loft.");
  if(!inputs.Has("sections"))throw CadError("LOFT_SECTIONS_REQUIRED","Select actual Faces using inputs.sections. A whole Body's bounding box is not a Loft profile.");
  FeatureNode feature;feature.Id=nextFeatureId();feature.Type="detail.loft";configureLoft(feature,inputs.At("sections"),parameters);
  std::vector<LoftProfile> profiles;std::string firstBody;
  const auto references=JsonParser(feature.StringParameters.at("loftSections")).Parse();
  for(const auto& reference:references.AsArray()){
    const auto& source=bodyOrActive(reference.GetString("bodyId"));if(firstBody.empty())firstBody=source.Id;
    profiles.push_back(ResolveLoftProfile(source.Shape,source.Names,reference));
  }
  const auto built=BuildLoft(profiles,feature);const auto& source=bodyOrActive(firstBody);
  BodyRecord output;output.Id=nextBodyId();output.SourceFeatureId=feature.Id;output.Shape=built.Shape;output.Names=built.Names;
  output.Label=myShapeTool->AddShape(output.Shape,false,false);output.TopologyRevision=++myRevision;output.Name="Loft";output.Color=source.Color;output.Material=source.Material;output.Kind=BodyKindFromShape(output.Shape);
  feature.OutputBodies={output.Id};StoreBodyDisplayMetadata(feature,"outputBodyMeta",output);
  feature.ComputedRevision=myRevision;myProperties.CopyBodyProperties(source.Id,output.Id,"Loft Body properties inherited; section Faces are preserved");
  myBodies.emplace(output.Id,output);myFeatures.push_back(feature);myActiveBodyId=output.Id;persistMetadata();return View(requestId);
}
}
