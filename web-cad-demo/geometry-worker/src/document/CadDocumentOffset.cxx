#include "CadDocument.hxx"
#include "BodyDisplayMetadata.hxx"

#include "CadError.hxx"
#include "TopologyHistory.hxx"
#include "SolidOrientation.hxx"
#include "../presentation/ShapeSerializer.hxx"

#include <BRepCheck_Analyzer.hxx>
#include <BRepOffsetAPI_MakeOffsetShape.hxx>
#include <BRepOffsetAPI_MakeThickSolid.hxx>
#include <GeomAbs_JoinType.hxx>
#include <NCollection_List.hxx>
#include <Precision.hxx>
#include <TopoDS.hxx>

#include <cmath>
#include <set>

namespace
{
void requireOffsetValue(const double value, const std::string& label, const bool allowNegative)
{
  if (!std::isfinite(value) || value == 0.0 || std::abs(value) > 1000.0
      || (!allowNegative && value < 0.0))
    throw occweb::CadError("INVALID_PARAMETER", label + " must be "
      + (allowNegative ? "non-zero and " : "positive and ") + "within 1000 mm.");
}

void requireResult(const TopoDS_Shape& shape, const std::string& operation)
{
  if (shape.IsNull() || !BRepCheck_Analyzer(shape).IsValid())
    throw occweb::CadError("INVALID_RESULT", operation + " did not produce a valid shape.");
}

void storeBodyMetadata(occweb::FeatureNode& feature, const occweb::BodyRecord& body)
{
  occweb::StoreBodyDisplayMetadata(feature,"outputBodyMeta",body);
}
}

namespace occweb
{
std::string CadDocument::OffsetFeature(const std::string& requestId, const int expectedRevision,
                                       const std::string& operation, const std::string& bodyId,
                                       const std::string& faceId, const JsonValue& parameters)
{
  if (expectedRevision != myRevision)
    throw CadError("STALE_REVISION", "Model revision is stale. Reload the current model and select the geometry again.");
  if (operation != "detail.shell" && operation != "detail.thicken" && operation != "detail.offset")
    throw CadError("UNKNOWN_OPERATION", "Unsupported offset feature: " + operation);

  FeatureNode feature;
  feature.Id = nextFeatureId();
  feature.Type = operation;

  if (operation == "detail.offset")
  {
    BodyRecord& body = bodyOrActive(bodyId);
    const double distance = parameterValue(parameters, "distance", "length", 0.0, true, &feature);
    requireOffsetValue(distance, "Offset distance", true);
    feature.InputFeatures.push_back(body.SourceFeatureId);
    feature.OutputBodies.push_back(body.Id);

    ShapeSerializer current(body.Shape, body.TopologyRevision, body.Id);
    BRepOffsetAPI_MakeOffsetShape builder;
    builder.PerformByJoin(body.Shape, distance, Precision::Confusion(), BRepOffset_Skin,
                          false, false, GeomAbs_Arc, true);
    if (!builder.IsDone())
      throw CadError("BUILD_FAILED", "OCCT could not offset this Body. Try a smaller distance.");
    const TopoDS_Shape result = builder.Shape();
    requireResult(result, "Offset");

    ++myRevision;
    feature.ComputedRevision = myRevision;
    ShapeSerializer nextTopology(result, myRevision, body.Id);
    const auto remap=TopologyHistory::Build(current,nextTopology,body.TopologyRevision,myRevision,builder);
    myProperties.RemapTopology(body.Id,body.Id,remap,operation);
    feature.RecordTopologyLineage(body.Id,body.TopologyRevision,body.Id,myRevision,remap);
    body.Names=TopologyNaming::FeatureResult(body.Shape,body.Names,result,builder,feature.Id);
    body.Shape = result;
    body.Kind = BodyKindFromShape(result);
    body.SourceFeatureId = feature.Id;
    body.TopologyRevision = myRevision;
    myShapeTool->SetShape(body.Label, result);
    myActiveBodyId = body.Id;
    myFeatures.push_back(feature);
    persistMetadata();
    return nextTopology.Serialize(responsePrefix(requestId));
  }

  const BodyRecord source = bodyOrActive(bodyId);
  if (operation == "detail.shell" && source.Kind != "solid")
    throw CadError("BODY_KIND_MISMATCH", "Shell requires a Solid Body. Use Thicken to convert a Sheet Body first.");
  ShapeSerializer current(source.Shape, source.TopologyRevision, source.Id);
  const int faceIndex = current.FaceIndexFromId(faceId);
  if (faceIndex < 1 || faceIndex > current.Faces().Extent())
    throw CadError("FACE_NOT_FOUND", "The selected face does not exist in this model revision.");
  const TopoDS_Face selectedFace = TopoDS::Face(current.Faces()(faceIndex));
  const double thickness = parameterValue(parameters, "thickness", "length", 0.0, true, &feature);
  requireOffsetValue(thickness, operation == "detail.shell" ? "Shell thickness" : "Thicken distance", false);
  feature.StringParameters["faceId"] = faceId;
  feature.StringParameters["selection.faceId"] = TopologyNaming::CaptureSelection(source.Shape, source.Names, "face", faceIndex);
  feature.InputFeatures.push_back(source.SourceFeatureId);

  if (operation == "detail.shell")
  {
    const bool inward = parameters.GetBooleanOr("inward", true);
    feature.StringParameters["inward"] = inward ? "true" : "false";
    feature.OutputBodies.push_back(source.Id);
    NCollection_List<TopoDS_Shape> closingFaces;
    closingFaces.Append(selectedFace);
    BRepOffsetAPI_MakeThickSolid builder;
    builder.MakeThickSolidByJoin(source.Shape, closingFaces, inward ? -thickness : thickness,
                                 Precision::Confusion(), BRepOffset_Skin,
                                 false, false, GeomAbs_Arc, true);
    if (!builder.IsDone())
      throw CadError("BUILD_FAILED", "OCCT could not shell this Body. Try a smaller thickness or another opening face.");
    const TopoDS_Shape result = builder.Shape();
    requireResult(result, "Shell");

    ++myRevision;
    feature.ComputedRevision = myRevision;
    BodyRecord& body = myBodies.at(source.Id);
    ShapeSerializer nextTopology(result, myRevision, body.Id);
    const auto remap=TopologyHistory::Build(current,nextTopology,body.TopologyRevision,myRevision,builder,{faceId});
    myProperties.RemapTopology(body.Id,body.Id,remap,operation);
    feature.RecordTopologyLineage(body.Id,body.TopologyRevision,body.Id,myRevision,remap);
    body.Names=TopologyNaming::FeatureResult(source.Shape,source.Names,result,builder,feature.Id,{selectedFace});
    body.Shape = result;
    body.Kind = BodyKindFromShape(result);
    body.SourceFeatureId = feature.Id;
    body.TopologyRevision = myRevision;
    myShapeTool->SetShape(body.Label, result);
    myActiveBodyId = body.Id;
    myFeatures.push_back(feature);
    persistMetadata();
    return nextTopology.Serialize(responsePrefix(requestId));
  }

  const bool reverse = parameters.GetBooleanOr("reverse", false);
  feature.StringParameters["reverse"] = reverse ? "true" : "false";
  feature.StringParameters["sourceBody"] = source.Id;
  BRepOffsetAPI_MakeThickSolid builder;
  builder.MakeThickSolidBySimple(selectedFace, reverse ? -thickness : thickness);
  if (!builder.IsDone())
    throw CadError("BUILD_FAILED", "OCCT could not thicken this Face. Try a smaller thickness or reverse the direction.");
  const TopoDS_Shape result = OrientClosedSolidResult(builder.Shape());
  requireResult(result, "Thicken");

  ++myRevision;
  feature.ComputedRevision = myRevision;
  BodyRecord output = source;
  output.Id = nextBodyId();
  output.SourceFeatureId = feature.Id;
  output.Shape = result;
  output.Names=TopologyNaming::FeatureResult(selectedFace,TopologyNaming::Restrict(source.Shape,source.Names,selectedFace),result,builder,feature.Id);
  output.Kind = BodyKindFromShape(result);
  output.Label = myShapeTool->AddShape(result, false, false);
  output.TopologyRevision = myRevision;
  output.Name = source.Name + " Thickened";
  feature.OutputBodies.push_back(output.Id);
  storeBodyMetadata(feature, output);
  myActiveBodyId = output.Id;
  myBodies.emplace(output.Id, output);
  myFeatures.push_back(feature);
  persistMetadata();
  return ShapeSerializer(result, myRevision, output.Id).Serialize(responsePrefix(requestId));
}
}
