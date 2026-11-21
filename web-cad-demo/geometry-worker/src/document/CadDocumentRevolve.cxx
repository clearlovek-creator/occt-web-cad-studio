#include "CadDocument.hxx"
#include "BodyDisplayMetadata.hxx"

#include "CadError.hxx"
#include "TopologyHistory.hxx"
#include "../presentation/ShapeSerializer.hxx"

#include <BRepCheck_Analyzer.hxx>
#include <TopoDS.hxx>
#include <BRepPrimAPI_MakeRevol.hxx>
#include <gp_Ax1.hxx>
#include <gp_Dir.hxx>
#include <gp_Pnt.hxx>

#include <cmath>

namespace occweb
{
std::string CadDocument::Revolve(const std::string& requestId, const int expectedRevision,
                                 const std::string& bodyId, const std::string& faceId,
                                 const JsonValue& parameters)
{
  if (expectedRevision != myRevision)
    throw CadError("STALE_REVISION", "Model revision is stale. Reload before creating a Revolve.");
  const BodyRecord& source = bodyOrActive(bodyId);
  ShapeSerializer sourceTopology(source.Shape, source.TopologyRevision, source.Id);
  const int faceIndex = sourceTopology.FaceIndexFromId(faceId);
  if (faceIndex < 1 || faceIndex > sourceTopology.Faces().Extent())
    throw CadError("FACE_NOT_FOUND", "The selected Revolve Face does not exist.");
  const TopoDS_Face face = TopoDS::Face(sourceTopology.Faces()(faceIndex));

  const double angleDegrees = parameterValue(parameters, "angleDegrees", "angle", 360.0, true);
  if (!std::isfinite(angleDegrees) || std::abs(angleDegrees) < 1.0e-8 || std::abs(angleDegrees) > 360.0)
    throw CadError("INVALID_PARAMETER", "Revolve angle must be between 0 and 360 degrees.");
  const double originX = parameterValue(parameters, "originX", "length", 0.0, false);
  const double originY = parameterValue(parameters, "originY", "length", 0.0, false);
  const double originZ = parameterValue(parameters, "originZ", "length", 0.0, false);
  const double axisX = parameterValue(parameters, "axisX", "dimensionless", 0.0, false);
  const double axisY = parameterValue(parameters, "axisY", "dimensionless", 0.0, false);
  const double axisZ = parameterValue(parameters, "axisZ", "dimensionless", 1.0, false);
  if (axisX * axisX + axisY * axisY + axisZ * axisZ < 1.0e-24)
    throw CadError("INVALID_PARAMETER", "Revolve axis direction must be non-zero.");

  BRepPrimAPI_MakeRevol builder(face,
    gp_Ax1(gp_Pnt(originX, originY, originZ), gp_Dir(axisX, axisY, axisZ)),
    angleDegrees * 3.14159265358979323846 / 180.0, true);
  builder.Build();
  if (!builder.IsDone())
    throw CadError("BUILD_FAILED", "OCCT could not build the Revolve.");
  const TopoDS_Shape result = builder.Shape();
  if (result.IsNull() || !BRepCheck_Analyzer(result).IsValid())
    throw CadError("INVALID_RESULT", "Revolve produced an invalid Body.");

  FeatureNode feature;
  feature.Id = nextFeatureId();
  feature.Type = "detail.revolve";
  feature.InputFeatures = {source.SourceFeatureId};
  feature.StringParameters["sourceBody"] = source.Id;
  feature.StringParameters["faceId"] = faceId;
  feature.StringParameters["selection.faceId"] = TopologyNaming::CaptureSelection(source.Shape, source.Names, "face", faceIndex);
  feature.NumberParameters["angleDegrees"] = angleDegrees;
  feature.NumberParameters["originX"] = originX;
  feature.NumberParameters["originY"] = originY;
  feature.NumberParameters["originZ"] = originZ;
  feature.NumberParameters["axisX"] = axisX;
  feature.NumberParameters["axisY"] = axisY;
  feature.NumberParameters["axisZ"] = axisZ;

  BodyRecord output;
  output.Id = nextBodyId();
  output.SourceFeatureId = feature.Id;
  output.Shape = result;
  output.Names=TopologyNaming::SweepResult(face,TopologyNaming::Restrict(source.Shape,source.Names,face),result,builder,feature.Id,builder.FirstShape(),builder.LastShape());
  output.Label = myShapeTool->AddShape(result, false, false);
  output.TopologyRevision = myRevision + 1;
  output.Name = source.Name + " Revolve";
  output.Color = source.Color;
  output.Material = source.Material;
  output.Kind = BodyKindFromShape(result);
  feature.OutputBodies = {output.Id};
  StoreBodyDisplayMetadata(feature,"outputBodyMeta",output);

  ++myRevision;
  output.TopologyRevision = myRevision;
  myProperties.CopyBodyProperties(source.Id, output.Id, "detail.revolve: Body properties inherited");
  feature.ComputedRevision = myRevision;
  myBodies.emplace(output.Id, output);
  myFeatures.push_back(feature);
  myActiveBodyId = output.Id;
  persistMetadata();
  return View(requestId);
}
}
