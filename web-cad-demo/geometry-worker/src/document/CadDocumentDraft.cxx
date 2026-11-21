#include "CadDocument.hxx"

#include "CadError.hxx"
#include "TopologyHistory.hxx"
#include "../presentation/ShapeSerializer.hxx"

#include <BRepAdaptor_Surface.hxx>
#include <BRepCheck_Analyzer.hxx>
#include <BRepOffsetAPI_DraftAngle.hxx>
#include <GeomAbs_SurfaceType.hxx>
#include <Precision.hxx>
#include <TopoDS.hxx>
#include <gp_Dir.hxx>
#include <gp_Pln.hxx>

#include <cmath>

namespace
{
void requireDirection(const double x, const double y, const double z, const std::string& label)
{
  if (!std::isfinite(x) || !std::isfinite(y) || !std::isfinite(z)
      || x * x + y * y + z * z < 1.0e-24)
    throw occweb::CadError("INVALID_PARAMETER", label + " must be a finite non-zero direction.");
}

void requireDraftAngle(const double angle)
{
  if (!std::isfinite(angle) || std::abs(angle) < 1.0e-8 || std::abs(angle) >= 89.0)
    throw occweb::CadError("INVALID_PARAMETER", "Draft angle must be non-zero and smaller than 89 degrees.");
}

TopoDS_Shape buildDraft(const TopoDS_Face& face,
                        const double angleDegrees, const gp_Dir& direction,
                        const gp_Pln& neutralPlane,BRepOffsetAPI_DraftAngle& builder)
{
  builder.Add(face, direction, angleDegrees * 3.14159265358979323846 / 180.0,
              neutralPlane, true);
  if (!builder.AddDone())
    throw occweb::CadError("BUILD_FAILED", "OCCT could not apply Draft to the selected Face.");
  builder.Build();
  if (!builder.IsDone())
    throw occweb::CadError("BUILD_FAILED", "OCCT could not finish Draft. Try a smaller angle or another neutral plane.");
  const TopoDS_Shape result = builder.Shape();
  if (result.IsNull() || !BRepCheck_Analyzer(result).IsValid())
    throw occweb::CadError("INVALID_RESULT", "Draft produced an invalid Body.");
  return result;
}
}

namespace occweb
{
std::string CadDocument::Draft(const std::string& requestId, const int expectedRevision,
                               const std::string& bodyId, const std::string& faceId,
                               const JsonValue& parameters)
{
  if (expectedRevision != myRevision)
    throw CadError("STALE_REVISION", "Model revision is stale. Reload the Body and Face before applying Draft.");

  BodyRecord& body = bodyOrActive(bodyId);
  if (body.Kind != "solid")
    throw CadError("BODY_KIND_MISMATCH", "Draft requires a Solid Body.");

  FeatureNode feature;
  feature.Id = nextFeatureId();
  feature.Type = "detail.draft";
  feature.InputFeatures.push_back(body.SourceFeatureId);
  feature.StringParameters["faceId"] = faceId;

  ShapeSerializer current(body.Shape, body.TopologyRevision, body.Id);
  const int faceIndex = current.FaceIndexFromId(faceId);
  if (faceIndex < 1 || faceIndex > current.Faces().Extent())
    throw CadError("FACE_NOT_FOUND", "The selected Face does not exist in this model revision.");
  const TopoDS_Face face = TopoDS::Face(current.Faces()(faceIndex));
  feature.StringParameters["selection.faceId"] = TopologyNaming::CaptureSelection(body.Shape, body.Names, "face", faceIndex);
  const GeomAbs_SurfaceType surfaceType = BRepAdaptor_Surface(face).GetType();
  if (surfaceType != GeomAbs_Plane && surfaceType != GeomAbs_Cylinder && surfaceType != GeomAbs_Cone)
    throw CadError("INVALID_FACE", "Draft supports planar, cylindrical or conical Faces only.");

  const double angleDegrees = parameterValue(parameters, "angleDegrees", "angle", 5.0, true, &feature);
  requireDraftAngle(angleDegrees);
  const double neutralOriginX = parameterValue(parameters, "neutralOriginX", "length", 0.0, false, &feature);
  const double neutralOriginY = parameterValue(parameters, "neutralOriginY", "length", 0.0, false, &feature);
  const double neutralOriginZ = parameterValue(parameters, "neutralOriginZ", "length", 0.0, false, &feature);
  const double neutralNormalX = parameterValue(parameters, "neutralNormalX", "dimensionless", 0.0, false, &feature);
  const double neutralNormalY = parameterValue(parameters, "neutralNormalY", "dimensionless", 0.0, false, &feature);
  const double neutralNormalZ = parameterValue(parameters, "neutralNormalZ", "dimensionless", 1.0, false, &feature);
  const double directionX = parameterValue(parameters, "directionX", "dimensionless", neutralNormalX, false, &feature);
  const double directionY = parameterValue(parameters, "directionY", "dimensionless", neutralNormalY, false, &feature);
  const double directionZ = parameterValue(parameters, "directionZ", "dimensionless", neutralNormalZ, false, &feature);
  requireDirection(neutralNormalX, neutralNormalY, neutralNormalZ, "Neutral plane normal");
  requireDirection(directionX, directionY, directionZ, "Draft direction");

  feature.NumberParameters["angleDegrees"] = angleDegrees;
  feature.NumberParameters["neutralOriginX"] = neutralOriginX;
  feature.NumberParameters["neutralOriginY"] = neutralOriginY;
  feature.NumberParameters["neutralOriginZ"] = neutralOriginZ;
  feature.NumberParameters["neutralNormalX"] = neutralNormalX;
  feature.NumberParameters["neutralNormalY"] = neutralNormalY;
  feature.NumberParameters["neutralNormalZ"] = neutralNormalZ;
  feature.NumberParameters["directionX"] = directionX;
  feature.NumberParameters["directionY"] = directionY;
  feature.NumberParameters["directionZ"] = directionZ;

  BRepOffsetAPI_DraftAngle builder(body.Shape);
  const TopoDS_Shape result = buildDraft(face, angleDegrees,
                                         gp_Dir(directionX, directionY, directionZ),
                                         gp_Pln(gp_Pnt(neutralOriginX, neutralOriginY, neutralOriginZ),
                                                gp_Dir(neutralNormalX, neutralNormalY, neutralNormalZ)),builder);
  ++myRevision;
  feature.ComputedRevision = myRevision;
  feature.OutputBodies.push_back(body.Id);
  ShapeSerializer nextTopology(result, myRevision, body.Id);
  const auto remap=TopologyHistory::Build(current,nextTopology,body.TopologyRevision,myRevision,builder);
  myProperties.RemapTopology(body.Id,body.Id,remap,"detail.draft");
  feature.RecordTopologyLineage(body.Id,body.TopologyRevision,body.Id,myRevision,remap);
  body.Names=TopologyNaming::FeatureResult(body.Shape,body.Names,result,builder,feature.Id);
  body.Shape = result;
  body.SourceFeatureId = feature.Id;
  body.TopologyRevision = myRevision;
  myShapeTool->SetShape(body.Label, result);
  myActiveBodyId = body.Id;
  myFeatures.push_back(feature);
  persistMetadata();
  return nextTopology.Serialize(responsePrefix(requestId));
}
}
