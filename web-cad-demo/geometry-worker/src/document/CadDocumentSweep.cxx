#include "CadDocument.hxx"
#include "BodyDisplayMetadata.hxx"
#include "CadError.hxx"
#include "TopologyHistory.hxx"
#include "../presentation/ShapeSerializer.hxx"
#include "../features/SweepBuilder.hxx"

#include <BRepCheck_Analyzer.hxx>
#include <BRepBndLib.hxx>
#include <BRepBuilderAPI_MakePolygon.hxx>
#include <BRepBuilderAPI_MakeFace.hxx>
#include <BRepPrimAPI_MakePrism.hxx>
#include <BRepOffsetAPI_ThruSections.hxx>
#include <Bnd_Box.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Face.hxx>
#include <TopoDS_Wire.hxx>
#include <gp_Dir.hxx>
#include <gp_Pnt.hxx>
#include <gp_Vec.hxx>

#include <algorithm>
#include <cmath>
#include <sstream>
#include <vector>
#include <set>

namespace occweb
{
namespace
{
double number(const JsonValue& parameters, const std::string& key, const double fallback)
{
  if (!parameters.IsObject() || !parameters.Has(key)) return fallback;
  return parameters.GetNumber(key);
}

void requireShape(const TopoDS_Shape& shape, const std::string& message)
{
  if (shape.IsNull() || !BRepCheck_Analyzer(shape).IsValid()) throw CadError("INVALID_RESULT", message);
}


}

void CadDocument::configureCurveSweep(FeatureNode& feature,const JsonValue& definition)
{
  for(const auto& [key,unused]:definition.AsObject())if(key!="profile" && key!="path" && key!="placement" && key!="frame" && key!="reverse")throw CadError("INVALID_PARAMETER","Unknown curved sweep definition field: "+key);
  const bool existing=IsCurveSweep(feature);
  const auto capture=[&](const JsonValue& selection,bool path){
    const auto id=selection.GetString("bodyId");if(id.empty())throw CadError("INVALID_SWEEP_REFERENCE","Select an explicit source Body; active Body fallback is not allowed.");
    const auto& body=bodyOrActive(id);ShapeSerializer topology(body.Shape,body.TopologyRevision,body.Id);
    auto source=std::find_if(myFeatures.begin(),myFeatures.end(),[&](const auto& candidate){return candidate.Id==body.SourceFeatureId;});
    if(source==myFeatures.end() || source->Id==feature.Id)throw CadError("SWEEP_DEPENDENCY_CYCLE","A sweep cannot use its own output as a profile or path.");
    if(source->Identity.empty())source->Identity=newIdentity();
    JsonValue reference=JsonValue::MakeObject();auto& fields=reference.ChangeObject();fields["bodyId"]=JsonValue(body.Id);fields["bodyIdentity"]=JsonValue(myEntityIdentities.at(body.Id).Body);fields["featureId"]=JsonValue(source->Id);fields["featureIdentity"]=JsonValue(source->Identity);
    if(path){
      if(selection.AsObject().size()!=2 || !selection.Has("edgeIds"))throw CadError("INVALID_SWEEP_PATH","A new path requires exactly bodyId and edgeIds.");
      const auto& ids=selection.At("edgeIds").AsArray();if(ids.empty() || ids.size()>32)throw CadError("INVALID_SWEEP_PATH","Select 1 to 32 ordered path Edges.");
      auto edges=JsonValue::MakeArray();std::set<int> used;
      for(const auto& value:ids){const int index=topology.EdgeIndexFromId(value.AsString());if(index<1 || index>topology.Edges().Extent())throw CadError("EDGE_NOT_FOUND","Selected path Edge does not exist.");if(!used.insert(index).second)throw CadError("INVALID_SWEEP_PATH","The same path Edge cannot be listed twice.");auto edge=JsonValue::MakeObject();edge.ChangeObject()["inputId"]=JsonValue("path-"+newIdentity());edge.ChangeObject()["selector"]=JsonValue(TopologyNaming::CaptureSelection(body.Shape,body.Names,"edge",index));edge.ChangeObject()["orientation"]=JsonValue(std::string(topology.Edges()(index).Orientation()==TopAbs_REVERSED?"reversed":"forward"));edges.ChangeArray().push_back(edge);}
      fields["edges"]=edges;
    }else{
      if(selection.AsObject().size()!=2 || !selection.Has("faceId"))throw CadError("INVALID_SWEEP_PROFILE","A new profile requires exactly bodyId and faceId.");
      const int index=topology.FaceIndexFromId(selection.GetString("faceId"));if(index<1 || index>topology.Faces().Extent())throw CadError("FACE_NOT_FOUND","Selected sweep profile Face does not exist.");fields["selector"]=JsonValue(TopologyNaming::CaptureSelection(body.Shape,body.Names,"face",index));
      feature.StringParameters["sourceBody"]=body.Id;feature.StringParameters["faceId"]=selection.GetString("faceId");
    }
    return reference;
  };
  for(const auto& role:{"profile","path"}){
    const std::string key=std::string("sweep")+(std::string(role)=="profile"?"Profile":"Path");
    if(const auto* value=definition.Find(role))feature.StringParameters[key]=JsonSerialize(capture(*value,std::string(role)=="path"));
    else if(!existing)throw CadError("SWEEP_INPUTS_REQUIRED","A new curved sweep requires both a planar Face profile and a real Edge path.");
  }
  feature.InputFeatures.clear();for(const auto& key:{"sweepProfile","sweepPath"}){const auto ref=JsonParser(feature.StringParameters.at(key)).Parse();const auto input=ref.GetString("featureId");if(std::find(feature.InputFeatures.begin(),feature.InputFeatures.end(),input)==feature.InputFeatures.end())feature.InputFeatures.push_back(input);}
  feature.StringParameters["sweepVersion"]="2";
  feature.StringParameters["sweepPlacement"]=definition.GetStringOr("placement",existing?feature.StringParameters.at("sweepPlacement"):"actual");
  feature.StringParameters["sweepFrame"]=definition.GetStringOr("frame",existing?feature.StringParameters.at("sweepFrame"):"corrected-frenet");
  feature.StringParameters["sweepReverse"]=definition.GetBooleanOr("reverse",existing&&feature.StringParameters.at("sweepReverse")=="true")?"true":"false";
  for(const auto& key:{"pathX","pathY","pathZ","dx","dy","dz"}){feature.NumberParameters.erase(key);feature.StringParameters.erase(std::string("expr.")+key);}feature.StringParameters.erase("selection.faceId");
}

std::string CadDocument::Sweep(const std::string& requestId, const int expectedRevision,
                               const std::string& bodyId, const std::string& faceId,
                               const std::string& operation, const JsonValue& parameters,const JsonValue& inputs)
{
  if (expectedRevision != myRevision) throw CadError("STALE_REVISION", "Model revision is stale. Reload before creating a sweep.");
  const BodyRecord& source = bodyOrActive(bodyId);
  if(inputs.Has("pathEdgeIds") || inputs.Has("pathBodyId")){
    auto definition=parameters;definition.ChangeObject()["profile"]=JsonParser("{\"bodyId\":\""+JsonEscape(bodyId)+"\",\"faceId\":\""+JsonEscape(faceId)+"\"}").Parse();
    auto path=JsonValue::MakeObject();path.ChangeObject()["bodyId"]=inputs.At("pathBodyId");path.ChangeObject()["edgeIds"]=inputs.At("pathEdgeIds");definition.ChangeObject()["path"]=path;
    FeatureNode feature;feature.Id=nextFeatureId();feature.Type=operation;configureCurveSweep(feature,definition);
    const auto profileRef=JsonParser(feature.StringParameters.at("sweepProfile")).Parse(),pathRef=JsonParser(feature.StringParameters.at("sweepPath")).Parse();
    const auto& pathBody=bodyOrActive(pathRef.GetString("bodyId"));
    const auto built=BuildCurveSweep(ResolveSweepProfile(source.Shape,source.Names,profileRef),ResolveSweepPath(pathBody.Shape,pathBody.Names,pathRef),feature);
    BodyRecord output;output.Id=nextBodyId();output.SourceFeatureId=feature.Id;output.Shape=built.Shape;output.Names=built.Names;output.Label=myShapeTool->AddShape(output.Shape,false,false);output.TopologyRevision=++myRevision;output.Name=source.Name+(operation=="detail.pipe"?" Pipe":" Sweep");output.Color=source.Color;output.Material=source.Material;output.Kind=BodyKindFromShape(output.Shape);
    feature.OutputBodies={output.Id};StoreBodyDisplayMetadata(feature,"outputBodyMeta",output);feature.ComputedRevision=myRevision;
    myProperties.CopyBodyProperties(source.Id,output.Id,operation+": curved sweep Body properties inherited");myBodies.emplace(output.Id,output);myFeatures.push_back(feature);myActiveBodyId=output.Id;persistMetadata();return View(requestId);
  }
  TopoDS_Shape profile = source.Shape;
  if (!faceId.empty())
  {
    ShapeSerializer topology(source.Shape, source.TopologyRevision, source.Id);
    const int index = topology.FaceIndexFromId(faceId);
    if (index < 1 || index > topology.Faces().Extent()) throw CadError("FACE_NOT_FOUND", "The selected sweep Face does not exist.");
    profile = TopoDS::Face(topology.Faces()(index));
  }
  const double dx = number(parameters, "pathX", number(parameters, "dx", 0.0));
  const double dy = number(parameters, "pathY", number(parameters, "dy", 0.0));
  const double dz = number(parameters, "pathZ", number(parameters, "dz", 10.0));
  if (!std::isfinite(dx) || !std::isfinite(dy) || !std::isfinite(dz) || dx * dx + dy * dy + dz * dz < 1.0e-16)
    throw CadError("INVALID_PARAMETER", "Sweep path vector must be finite and non-zero.");
  BRepPrimAPI_MakePrism builder(profile, gp_Vec(dx, dy, dz), true);
  builder.Build();
  if (!builder.IsDone()) throw CadError("BUILD_FAILED", "OCCT could not build the sweep/pipe.");
  const TopoDS_Shape result = builder.Shape();
  requireShape(result, "Sweep/pipe produced an invalid Body.");

  FeatureNode feature;
  feature.Id = nextFeatureId();
  feature.Type = operation;
  feature.InputFeatures = {source.SourceFeatureId};
  feature.StringParameters["sourceBody"] = source.Id;
  feature.StringParameters["faceId"] = faceId;
  if (!faceId.empty()) {
    ShapeSerializer topology(source.Shape, source.TopologyRevision, source.Id);
    feature.StringParameters["selection.faceId"] = TopologyNaming::CaptureSelection(source.Shape, source.Names, "face", topology.FaceIndexFromId(faceId));
  }
  feature.NumberParameters["pathX"] = dx;
  feature.NumberParameters["pathY"] = dy;
  feature.NumberParameters["pathZ"] = dz;
  BodyRecord output;
  output.Id = nextBodyId();
  output.SourceFeatureId = feature.Id;
  output.Shape = result;
  output.Names=TopologyNaming::SweepResult(profile,TopologyNaming::Restrict(source.Shape,source.Names,profile),result,builder,feature.Id,builder.FirstShape(),builder.LastShape());
  output.Label = myShapeTool->AddShape(result, false, false);
  output.TopologyRevision = myRevision + 1;
  output.Name = source.Name + (operation == "detail.pipe" ? " Pipe" : " Sweep");
  output.Color = source.Color;
  output.Material = source.Material;
  output.Kind = BodyKindFromShape(result);
  feature.OutputBodies = {output.Id};
  StoreBodyDisplayMetadata(feature,"outputBodyMeta",output);
  ++myRevision;
  output.TopologyRevision = myRevision;
  myProperties.CopyBodyProperties(source.Id, output.Id, operation + ": Body properties inherited");
  feature.ComputedRevision = myRevision;
  myBodies.emplace(output.Id, output);
  myFeatures.push_back(feature);
  myActiveBodyId = output.Id;
  persistMetadata();
  return View(requestId);
}

}
