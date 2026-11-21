#include "CadDocument.hxx"

#include "CadError.hxx"
#include "TopologyHistory.hxx"
#include "../presentation/ShapeSerializer.hxx"

#include <BRepBuilderAPI_Transform.hxx>
#include <BRepCheck_Analyzer.hxx>
#include <gp_Ax1.hxx>
#include <gp_Ax2.hxx>
#include <gp_Dir.hxx>
#include <gp_Pnt.hxx>
#include <gp_Trsf.hxx>
#include <gp_Vec.hxx>

#include <cmath>

namespace occweb
{
std::string CadDocument::Transform(const std::string& requestId, const int expectedRevision,
                                   const std::string& operation, const std::string& bodyId,
                                   const JsonValue& parameters)
{
  if (expectedRevision != myRevision)
    throw CadError("STALE_REVISION", "Document revision is stale. Reload before transforming the body.");

  FeatureNode feature;
  feature.Id = nextFeatureId();
  feature.Type = operation;
  gp_Trsf transform;
  if (operation == "transform.translate")
  {
    const double dx = parameterValue(parameters, "dx", "length", 0.0, false, &feature);
    const double dy = parameterValue(parameters, "dy", "length", 0.0, false, &feature);
    const double dz = parameterValue(parameters, "dz", "length", 0.0, false, &feature);
    transform.SetTranslation(gp_Vec(dx, dy, dz));
  }
  else if (operation == "transform.rotate")
  {
    const double angle = parameterValue(parameters, "angleDegrees", "angle", 0.0, true, &feature);
    const double x = parameterValue(parameters, "axisX", "dimensionless", 0.0, false, &feature);
    const double y = parameterValue(parameters, "axisY", "dimensionless", 0.0, false, &feature);
    const double z = parameterValue(parameters, "axisZ", "dimensionless", 1.0, false, &feature);
    if (x*x + y*y + z*z < 1.0e-24 || std::abs(angle) > 360000.0)
      throw CadError("INVALID_PARAMETER", "Rotation requires a non-zero axis and a finite angle.");
    const gp_Pnt origin(parameterValue(parameters, "originX", "length", 0.0, false, &feature),
                        parameterValue(parameters, "originY", "length", 0.0, false, &feature),
                        parameterValue(parameters, "originZ", "length", 0.0, false, &feature));
    transform.SetRotation(gp_Ax1(origin, gp_Dir(x,y,z)), angle * 3.14159265358979323846 / 180.0);
  }
  else if (operation == "transform.mirror")
  {
    const std::string mode = parameters.GetStringOr("mode", "plane");
    feature.StringParameters["mode"] = mode;
    const gp_Pnt origin(parameterValue(parameters, "originX", "length", 0.0, false, &feature),
                        parameterValue(parameters, "originY", "length", 0.0, false, &feature),
                        parameterValue(parameters, "originZ", "length", 0.0, false, &feature));
    if (mode == "point") transform.SetMirror(origin);
    else
    {
      const double x = parameterValue(parameters, "normalX", "dimensionless", 1.0, false, &feature);
      const double y = parameterValue(parameters, "normalY", "dimensionless", 0.0, false, &feature);
      const double z = parameterValue(parameters, "normalZ", "dimensionless", 0.0, false, &feature);
      if (x*x + y*y + z*z < 1.0e-24)
        throw CadError("INVALID_PARAMETER", "Mirror axis/plane direction must be non-zero.");
      if (mode == "axis") transform.SetMirror(gp_Ax1(origin, gp_Dir(x,y,z)));
      else if (mode == "plane") transform.SetMirror(gp_Ax2(origin, gp_Dir(x,y,z)));
      else throw CadError("INVALID_PARAMETER", "Mirror mode must be point, axis or plane.");
    }
  }
  else if (operation == "transform.scale")
  {
    const double factor = parameterValue(parameters, "factor", "dimensionless", 1.0, true, &feature);
    if (factor <= 0.0 || factor > 1000.0)
      throw CadError("INVALID_PARAMETER", "Uniform scale factor must be between 0 and 1000.");
    const gp_Pnt origin(parameterValue(parameters, "originX", "length", 0.0, false, &feature),
                        parameterValue(parameters, "originY", "length", 0.0, false, &feature),
                        parameterValue(parameters, "originZ", "length", 0.0, false, &feature));
    transform.SetScale(origin, factor);
  }
  else throw CadError("UNKNOWN_OPERATION", "Unsupported transform operation: " + operation);

  BodyRecord& body = bodyOrActive(bodyId);
  ShapeSerializer oldTopology(body.Shape, body.TopologyRevision, body.Id);
  BRepBuilderAPI_Transform builder(body.Shape, transform, true);
  builder.Build();
  if (!builder.IsDone()) throw CadError("BUILD_FAILED", "OCCT could not transform the Body.");
  const TopoDS_Shape result = builder.Shape();
  if (result.IsNull() || !BRepCheck_Analyzer(result).IsValid())
    throw CadError("INVALID_RESULT", "The transformed Body is invalid.");

  ++myRevision;
  feature.ComputedRevision = myRevision;
  feature.InputFeatures = {body.SourceFeatureId};
  feature.OutputBodies = {body.Id};
  ShapeSerializer nextTopology(result, myRevision, body.Id);
  const auto remap=TopologyHistory::Build(oldTopology,nextTopology,body.TopologyRevision,myRevision,builder);
  myProperties.RemapTopology(body.Id, body.Id,remap,operation);
  feature.RecordTopologyLineage(body.Id,body.TopologyRevision,body.Id,myRevision,remap);
  body.Names=TopologyNaming::Propagate(body.Shape,body.Names,result,builder);
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
