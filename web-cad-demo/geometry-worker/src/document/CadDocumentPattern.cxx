#include "CadDocument.hxx"
#include "BodyDisplayMetadata.hxx"

#include "CadError.hxx"
#include "TopologyHistory.hxx"
#include "../presentation/ShapeSerializer.hxx"
#include "../features/PatternIdentity.hxx"
#include <BRepTools_History.hxx>

#include <BRepBuilderAPI_Transform.hxx>
#include <BRepCheck_Analyzer.hxx>
#include <gp_Ax1.hxx>
#include <gp_Ax2.hxx>
#include <gp_Dir.hxx>
#include <gp_Pnt.hxx>
#include <gp_Vec.hxx>

#include <cmath>
#include <vector>

namespace
{
void requirePatternCount(const double value)
{
  if (!std::isfinite(value) || std::round(value) != value || value < 2.0 || value > 100.0)
    throw occweb::CadError("INVALID_PARAMETER", "Pattern count must be an integer between 2 and 100.");
}

void requirePatternDirection(const double x, const double y, const double z)
{
  if (!std::isfinite(x) || !std::isfinite(y) || !std::isfinite(z)
      || x * x + y * y + z * z < 1.0e-24)
    throw occweb::CadError("INVALID_PARAMETER", "Pattern direction must be finite and non-zero.");
}
}

namespace occweb
{
std::string CadDocument::Pattern(const std::string& requestId, const int expectedRevision,
                                 const std::string& operation, const std::string& bodyId,
                                 const JsonValue& parameters)
{
  if (expectedRevision != myRevision)
    throw CadError("STALE_REVISION", "Model revision is stale. Reload the Body before creating a pattern.");
  if (operation != "pattern.linear" && operation != "pattern.circular"
      && operation != "pattern.rectangular" && operation != "pattern.mirror")
    throw CadError("UNKNOWN_OPERATION", "Unsupported pattern operation: " + operation);

  const BodyRecord source = bodyOrActive(bodyId);
  const bool circular = operation == "pattern.circular";
  const bool rectangular = operation == "pattern.rectangular";
  const bool mirror = operation == "pattern.mirror";
  int count = 0;
  int countX = 1;
  int countY = 1;
  if (rectangular)
  {
    const double countXValue = parameterValue(parameters, "countX", "integer", 2.0, true);
    const double countYValue = parameterValue(parameters, "countY", "integer", 2.0, true);
    if (!std::isfinite(countXValue) || std::round(countXValue) != countXValue || countXValue < 1.0 || countXValue > 20.0
        || !std::isfinite(countYValue) || std::round(countYValue) != countYValue || countYValue < 1.0 || countYValue > 20.0)
      throw CadError("INVALID_PARAMETER", "Rectangular pattern counts must be integers between 1 and 20.");
    countX = static_cast<int>(std::round(countXValue));
    countY = static_cast<int>(std::round(countYValue));
    count = countX * countY;
    if (count < 2 || count > 100)
      throw CadError("INVALID_PARAMETER", "Rectangular pattern must produce between 2 and 100 instances.");
  }
  else if (mirror)
    count = 2;
  else
  {
    const double countValue = parameterValue(parameters, "count", "integer", 2.0, true);
    requirePatternCount(countValue);
    count = static_cast<int>(std::round(countValue));
  }

  const double spacing = (circular || rectangular || mirror) ? 0.0
    : parameterValue(parameters, "spacing", "length", 0.0, true);
  const double spacingX = rectangular ? parameterValue(parameters, "spacingX", "length", 0.0, true) : spacing;
  const double spacingY = rectangular ? parameterValue(parameters, "spacingY", "length", 0.0, true) : 0.0;
  if ((!circular && !rectangular && !mirror && (!std::isfinite(spacing) || spacing == 0.0 || std::abs(spacing) > 100000.0))
      || (rectangular && (!std::isfinite(spacingX) || !std::isfinite(spacingY) || spacingX == 0.0 || spacingY == 0.0
                          || std::abs(spacingX) > 100000.0 || std::abs(spacingY) > 100000.0)))
    throw CadError("INVALID_PARAMETER", "Pattern spacing must be non-zero and within 100000 mm.");

  const double angleDegrees = circular ? parameterValue(parameters, "angleDegrees", "angle", 360.0, true) : 0.0;
  if (circular && (!std::isfinite(angleDegrees) || std::abs(angleDegrees) < 1.0e-8 || std::abs(angleDegrees) > 36000.0))
    throw CadError("INVALID_PARAMETER", "Circular pattern angle must be finite and within 36000 degrees.");

  const double directionX = parameterValue(parameters,
    circular ? "axisX" : mirror ? "normalX" : "directionX", "dimensionless", 1.0, false);
  const double directionY = parameterValue(parameters,
    circular ? "axisY" : mirror ? "normalY" : "directionY", "dimensionless", 0.0, false);
  const double directionZ = parameterValue(parameters,
    circular ? "axisZ" : mirror ? "normalZ" : "directionZ", "dimensionless", 0.0, false);
  requirePatternDirection(directionX, directionY, directionZ);
  const gp_Dir direction(directionX, directionY, directionZ);

  const double direction2X = rectangular ? parameterValue(parameters, "direction2X", "dimensionless", 0.0, false) : 0.0;
  const double direction2Y = rectangular ? parameterValue(parameters, "direction2Y", "dimensionless", 1.0, false) : 0.0;
  const double direction2Z = rectangular ? parameterValue(parameters, "direction2Z", "dimensionless", 0.0, false) : 0.0;
  if (rectangular) requirePatternDirection(direction2X, direction2Y, direction2Z);
  const gp_Dir direction2(rectangular ? direction2X : 0.0, rectangular ? direction2Y : 1.0, rectangular ? direction2Z : 0.0);

  const double originX = (circular || mirror) ? parameterValue(parameters, "originX", "length", 0.0, false) : 0.0;
  const double originY = (circular || mirror) ? parameterValue(parameters, "originY", "length", 0.0, false) : 0.0;
  const double originZ = (circular || mirror) ? parameterValue(parameters, "originZ", "length", 0.0, false) : 0.0;

  FeatureNode feature;
  feature.Id = nextFeatureId();
  feature.Type = operation;
  feature.InputFeatures.push_back(source.SourceFeatureId);
  feature.StringParameters["sourceBody"] = source.Id;
  if (!mirror) feature.NumberParameters["count"] = count;
  if (circular)
  {
    feature.NumberParameters["angleDegrees"] = angleDegrees;
    feature.NumberParameters["originX"] = originX;
    feature.NumberParameters["originY"] = originY;
    feature.NumberParameters["originZ"] = originZ;
    feature.NumberParameters["axisX"] = directionX;
    feature.NumberParameters["axisY"] = directionY;
    feature.NumberParameters["axisZ"] = directionZ;
  }
  else if (mirror)
  {
    feature.NumberParameters["originX"] = originX;
    feature.NumberParameters["originY"] = originY;
    feature.NumberParameters["originZ"] = originZ;
    feature.NumberParameters["normalX"] = directionX;
    feature.NumberParameters["normalY"] = directionY;
    feature.NumberParameters["normalZ"] = directionZ;
  }
  else if (rectangular)
  {
    feature.NumberParameters["countX"] = countX;
    feature.NumberParameters["countY"] = countY;
    feature.NumberParameters["spacingX"] = spacingX;
    feature.NumberParameters["spacingY"] = spacingY;
    feature.NumberParameters["directionX"] = directionX;
    feature.NumberParameters["directionY"] = directionY;
    feature.NumberParameters["directionZ"] = directionZ;
    feature.NumberParameters["direction2X"] = direction2X;
    feature.NumberParameters["direction2Y"] = direction2Y;
    feature.NumberParameters["direction2Z"] = direction2Z;
  }
  else
  {
    feature.NumberParameters["spacing"] = spacing;
    feature.NumberParameters["directionX"] = directionX;
    feature.NumberParameters["directionY"] = directionY;
    feature.NumberParameters["directionZ"] = directionZ;
  }

  for (const auto& [key, value] : parameters.AsObject())
    if (value.IsString() && feature.NumberParameters.find(key) != feature.NumberParameters.end())
      feature.StringParameters["expr." + key] = value.AsString();

  const int nextRevision = myRevision + 1;
  std::vector<BodyRecord> outputs;
  std::vector<TopologyRemap> remaps;
  ShapeSerializer oldTopology(source.Shape,source.TopologyRevision,source.Id);
  outputs.reserve(static_cast<std::size_t>(count));
  for (int index = 0; index < count; ++index)
  {
    BodyRecord output = source;
    output.Id = index == 0 ? source.Id : nextBodyId();
    if (index > 0)
    {
      gp_Trsf transform;
      if (mirror)
        transform.SetMirror(gp_Ax2(gp_Pnt(originX, originY, originZ), direction));
      else if (circular)
        transform.SetRotation(gp_Ax1(gp_Pnt(originX, originY, originZ), direction),
                              angleDegrees * 3.14159265358979323846 / 180.0 * index);
      else if (rectangular)
      {
        const int row = index / countX;
        const int column = index % countX;
        transform.SetTranslation(gp_Vec(direction) * spacingX * column
                                 + gp_Vec(direction2) * spacingY * row);
      }
      else
        transform.SetTranslation(gp_Vec(direction) * spacing * index);

      BRepBuilderAPI_Transform builder(source.Shape, transform, true);
      builder.Build();
      if (!builder.IsDone())
        throw CadError("BUILD_FAILED", mirror ? "OCCT could not create a mirror pattern instance."
          : circular ? "OCCT could not create a circular pattern instance."
          : rectangular ? "OCCT could not create a rectangular pattern instance."
          : "OCCT could not create a linear pattern instance.");
      output.Shape = builder.Shape();
      if (output.Shape.IsNull() || !BRepCheck_Analyzer(output.Shape).IsValid())
        throw CadError("INVALID_RESULT", mirror ? "Mirror pattern produced an invalid Body."
          : circular ? "Circular pattern produced an invalid Body."
          : rectangular ? "Rectangular pattern produced an invalid Body."
          : "Linear pattern produced an invalid Body.");
      output.Label = myShapeTool->AddShape(output.Shape, false, false);
      output.Names=TopologyNaming::Instance(TopologyNaming::Propagate(source.Shape,source.Names,output.Shape,builder),feature.Id,PatternSlot(feature,index));
      ShapeSerializer nextTopology(output.Shape,nextRevision,output.Id);
      remaps.push_back(TopologyHistory::Build(oldTopology,nextTopology,source.TopologyRevision,nextRevision,builder));
    }
    else {
      ShapeSerializer nextTopology(output.Shape,nextRevision,output.Id);BRepTools_History identity;
      remaps.push_back(TopologyHistory::Build(oldTopology,nextTopology,source.TopologyRevision,nextRevision,identity));
    }
    output.SourceFeatureId = feature.Id;
    feature.StringParameters["patternSlot."+output.Id]=PatternSlot(feature,index);
    output.TopologyRevision = nextRevision;
    output.Name = source.Name + (mirror ? " Mirror Pattern " : circular ? " Circular Pattern "
      : rectangular ? " Rectangular Pattern " : " Linear Pattern ") + std::to_string(index + 1);
    feature.OutputBodies.push_back(output.Id);
    outputs.push_back(output);
    StoreBodyDisplayMetadata(feature,"outputBodyMeta",output);
  }

  for (std::size_t outputIndex = 1; outputIndex < outputs.size(); ++outputIndex)
  {
    myProperties.CopyBodyProperties(source.Id, outputs[outputIndex].Id, operation + ": Body properties inherited");
    myProperties.CopyTopologyProperties(source.Id, outputs[outputIndex].Id, remaps[outputIndex], operation + ": topology properties inherited");
  }
  myProperties.RemapTopology(source.Id,outputs.front().Id,remaps.front(),operation);
  feature.RecordTopologyLineage(source.Id,source.TopologyRevision,outputs.front().Id,nextRevision,remaps.front());

  for (BodyRecord& output : outputs)
  {
    const auto existing = myBodies.find(output.Id);
    if (existing != myBodies.end())
    {
      output.Label = existing->second.Label;
      myShapeTool->SetShape(output.Label, output.Shape);
      existing->second = output;
    }
    else
      myBodies.emplace(output.Id, output);
  }
  myRevision = nextRevision;
  feature.ComputedRevision = myRevision;
  myActiveBodyId = outputs.front().Id;
  myFeatures.push_back(feature);
  persistMetadata();
  return View(requestId);
}
}
