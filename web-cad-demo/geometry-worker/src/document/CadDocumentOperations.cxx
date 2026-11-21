#include "CadDocument.hxx"

#include "CadError.hxx"
#include "ShapeSpatial.hxx"
#include "CoordinateReference.hxx"
#include "../presentation/ShapeSerializer.hxx"
#include "../presentation/FaceBoundaries.hxx"
#include "TopologyHistory.hxx"
#include "../protocol/Json.hxx"

#include <BRepAlgoAPI_Common.hxx>
#include <BRepAlgoAPI_Cut.hxx>
#include <BRepAlgoAPI_Fuse.hxx>
#include <BRepExtrema_DistShapeShape.hxx>
#include <BRepCheck_Analyzer.hxx>
#include <BRepBndLib.hxx>
#include <BRepGProp.hxx>
#include <BRepAdaptor_Curve.hxx>
#include <BRep_Tool.hxx>
#include <GeomAbs_CurveType.hxx>
#include <TopExp.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Face.hxx>
#include <TopoDS_Edge.hxx>
#include <TopoDS_Vertex.hxx>
#include <gp_Circ.hxx>
#include <gp_Pnt.hxx>
#include <GProp_GProps.hxx>
#include <Bnd_Box.hxx>
#include <Bnd_OBB.hxx>

#include <algorithm>
#include <cmath>
#include <functional>
#include <set>
#include <sstream>
#include <unordered_map>

namespace occweb
{

std::string CadDocument::ShapeCheck(const std::string& requestId, const std::string& bodyId) const
{
  const BodyRecord& body = bodyOrActive(bodyId);
  BRepCheck_Analyzer analyzer(body.Shape);
  const bool valid = !body.Shape.IsNull() && analyzer.IsValid();
  ShapeSerializer topology(body.Shape, body.TopologyRevision, body.Id);
  return responsePrefix(requestId)
       + ",\"bodyId\":\"" + JsonEscape(body.Id)
       + "\",\"valid\":" + (valid ? "true" : "false")
       + ",\"kind\":\"" + JsonEscape(body.Kind)
       + "\",\"faceCount\":" + std::to_string(topology.Faces().Extent())
       + ",\"edgeCount\":" + std::to_string(topology.Edges().Extent())
       + ",\"solidCount\":" + std::to_string(body.Kind == "solid" ? 1 : 0)
       + "}";
}


std::string CadDocument::Measure(const std::string& requestId, const std::string& bodyId,
                                 const std::string& selectionType, const std::string& topologyId) const
{
  const BodyRecord& body = bodyOrActive(bodyId);
  const std::string kind = selectionType.empty() ? "body" : selectionType;
  if (kind != "body" && kind != "face" && kind != "edge")
    throw CadError("INVALID_SELECTION", "Measure selectionType must be body, face or edge.");

  const auto pointJson = [](const gp_Pnt& point)
  {
    return SpatialPointJson(point);
  };
  const auto boundsJson = [](const TopoDS_Shape& shape)
  {
    return std::string("\"bounds\":")+SpatialBoundsJson(shape);
  };
  const auto obbJson = [](const TopoDS_Shape& shape)
  {
    return std::string("\"obb\":")+SpatialObbJson(shape);
  };

  const std::string prefix = responsePrefix(requestId)
    + ",\"bodyId\":\"" + JsonEscape(body.Id)
    + "\",\"selectionType\":\"" + JsonEscape(kind) + "\"";
  if (kind == "body")
  {
    GProp_GProps volume;
    GProp_GProps area;
    GProp_GProps length;
    BRepGProp::VolumeProperties(body.Shape, volume);
    BRepGProp::SurfaceProperties(body.Shape, area);
    BRepGProp::LinearProperties(body.Shape, length, true, false);
    const std::string obb = obbJson(body.Shape);
    return prefix
      + ",\"selectionId\":\"" + JsonEscape(body.Id)
      + "\",\"volume\":" + SpatialNumber(volume.Mass())
      + ",\"area\":" + SpatialNumber(area.Mass())
      + ",\"length\":" + SpatialNumber(length.Mass())
      + ",\"edgeLengthPolicy\":\"unique-topological-edges\""
      + "," + boundsJson(body.Shape)
      + (obb.empty() ? std::string() : "," + obb)
      + "}";
  }

  ShapeSerializer topology(body.Shape, body.TopologyRevision, body.Id);
  if (kind == "face")
  {
    const int index = topology.FaceIndexFromId(topologyId);
    if (index < 1 || index > topology.Faces().Extent())
      throw CadError("FACE_NOT_FOUND", "The selected Face does not exist.");
    const TopoDS_Face face = TopoDS::Face(topology.Faces()(index));
    GProp_GProps surface;
    GProp_GProps perimeter;
    BRepGProp::SurfaceProperties(face, surface);
    BRepGProp::LinearProperties(face, perimeter);
    return prefix
      + ",\"selectionId\":\"" + JsonEscape(topologyId)
      + "\",\"area\":" + SpatialNumber(surface.Mass())
      + ",\"perimeter\":" + SpatialNumber(perimeter.Mass())
      + ",\"centroid\":" + pointJson(surface.CentreOfMass())
      + ",\"boundaryLoops\":" + JsonSerialize(FaceBoundaries(topology,index))
      + "," + boundsJson(face) + "}";
  }

  const int index = topology.EdgeIndexFromId(topologyId);
  if (index < 1 || index > topology.Edges().Extent())
    throw CadError("EDGE_NOT_FOUND", "The selected Edge does not exist.");
  const TopoDS_Edge edge = TopoDS::Edge(topology.Edges()(index));
  GProp_GProps linear;
  BRepGProp::LinearProperties(edge, linear);
  TopoDS_Vertex firstVertex;
  TopoDS_Vertex lastVertex;
  TopExp::Vertices(edge, firstVertex, lastVertex);
  BRepAdaptor_Curve curve(edge);
  std::string curveType = "other";
  switch (curve.GetType())
  {
    case GeomAbs_Line: curveType = "line"; break;
    case GeomAbs_Circle: curveType = "circle"; break;
    case GeomAbs_Ellipse: curveType = "ellipse"; break;
    case GeomAbs_Hyperbola: curveType = "hyperbola"; break;
    case GeomAbs_Parabola: curveType = "parabola"; break;
    case GeomAbs_BezierCurve: curveType = "bezier"; break;
    case GeomAbs_BSplineCurve: curveType = "bspline"; break;
    default: break;
  }
  std::string result = prefix
    + ",\"selectionId\":\"" + JsonEscape(topologyId)
    + "\",\"length\":" + SpatialNumber(linear.Mass())
    + ",\"curveType\":\"" + curveType + "\""
    + ",\"centroid\":" + pointJson(linear.CentreOfMass());
  if (!firstVertex.IsNull() && !lastVertex.IsNull())
    result += ",\"endpoints\":[" + pointJson(BRep_Tool::Pnt(firstVertex)) + "," + pointJson(BRep_Tool::Pnt(lastVertex)) + "]";
  if (curve.GetType() == GeomAbs_Circle)
  {
    const gp_Circ circle = curve.Circle();
    result += ",\"radius\":" + SpatialNumber(circle.Radius())
      + ",\"center\":" + pointJson(circle.Location());
  }
  return result + "," + boundsJson(edge) + "}";
}

std::string CadDocument::Relation(const std::string& requestId, const std::string& firstBodyId,
                                  const std::string& secondBodyId, const double tolerance) const
{
  if (!std::isfinite(tolerance) || tolerance < 0.0 || tolerance > 1.0)
    throw CadError("INVALID_PARAMETER", "Relation tolerance must be between 0 and 1 mm.");
  const BodyRecord& first = bodyOrActive(firstBodyId);
  const BodyRecord& second = bodyOrActive(secondBodyId);
  if (first.Id == second.Id)
    throw CadError("INVALID_RELATION", "Relation requires two distinct bodies.");

  BRepExtrema_DistShapeShape extrema(first.Shape, second.Shape, std::max(tolerance, 1.0e-7));
  if (!extrema.IsDone()) throw CadError("MEASURE_FAILED", "OCCT could not compute the BRep distance.");
  const double distance = std::max(0.0, extrema.Value());
  std::string relation = distance <= tolerance ? "touching" : "disjoint";
  double commonVolume = 0.0;
  if (distance <= tolerance)
  {
    BRepAlgoAPI_Common common(first.Shape, second.Shape);
    if (common.IsDone() && !common.Shape().IsNull())
    {
      GProp_GProps commonProperties;
      BRepGProp::VolumeProperties(common.Shape(), commonProperties);
      commonVolume = std::max(0.0, commonProperties.Mass());
      const double volumeTolerance = std::max(1.0e-9, tolerance * tolerance * tolerance);
      if (commonVolume > volumeTolerance) relation = "intersects";
    }
  }
  GProp_GProps firstProperties;
  GProp_GProps secondProperties;
  BRepGProp::VolumeProperties(first.Shape, firstProperties);
  BRepGProp::VolumeProperties(second.Shape, secondProperties);
  const double volumeTolerance = std::max(1.0e-9, tolerance * tolerance * tolerance);
  if (commonVolume > volumeTolerance && commonVolume >= secondProperties.Mass() - volumeTolerance)
    relation = "contains";
  else if (commonVolume > volumeTolerance && commonVolume >= firstProperties.Mass() - volumeTolerance)
    relation = "inside";

  const auto pointJson = [](const gp_Pnt& point)
  {
    return SpatialPointJson(point);
  };
  std::string points;
  if (extrema.NbSolution() > 0)
    points = ",\"closestPoints\":[" + pointJson(extrema.PointOnShape1(1)) + "," + pointJson(extrema.PointOnShape2(1)) + "]";
  return responsePrefix(requestId)
    + ",\"bodyA\":\"" + JsonEscape(first.Id)
    + "\",\"bodyB\":\"" + JsonEscape(second.Id)
    + "\",\"distance\":" + SpatialNumber(distance)
    + ",\"tolerance\":" + SpatialNumber(tolerance)
    + ",\"relation\":\"" + relation + "\""
    + ",\"commonVolume\":" + SpatialNumber(commonVolume)
    + ",\"innerSolution\":" + (extrema.InnerSolution() ? "true" : "false")
    + ",\"source\":\"occt-brep\",\"exact\":true" + points + "}";
}
std::string CadDocument::DeleteBody(const std::string& requestId, const int expectedRevision,
                                    const std::string& bodyId)
{
  if (expectedRevision != myRevision)
    throw CadError("STALE_REVISION", "Document revision is stale. Reload before deleting the body.");
  const auto body = myBodies.find(bodyId);
  if (body == myBodies.end()) throw CadError("BODY_NOT_FOUND", "The selected body does not exist.");

  std::unordered_map<std::string, const FeatureNode*> featuresById;
  for (const FeatureNode& feature : myFeatures) featuresById[feature.Id] = &feature;

  std::set<std::string> requiredFeatures;
  std::function<void(const std::string&)> requireFeature = [&](const std::string& featureId)
  {
    if (featureId.empty() || !requiredFeatures.insert(featureId).second) return;
    const auto found = featuresById.find(featureId);
    if (found == featuresById.end())
      throw CadError("INVALID_FEATURE_GRAPH", "A body references a feature that does not exist.");
    for (const std::string& input : found->second->InputFeatures) requireFeature(input);
    for (const auto& source:FeatureCoordinateSources(*found->second,myCoordinateSystems)) requireFeature(source);
  };
  for (const auto& [remainingId, remainingBody] : myBodies)
    if (remainingId != bodyId) requireFeature(remainingBody.SourceFeatureId);

  std::set<std::string> replayedBodies;
  for (const FeatureNode& feature : myFeatures)
  {
    if (requiredFeatures.find(feature.Id) == requiredFeatures.end()) continue;
    for (const std::string& outputBody : feature.OutputBodies) replayedBodies.insert(outputBody);
    if (feature.Type.rfind("boolean.", 0) == 0)
    {
      const auto tool = feature.StringParameters.find("toolBody");
      const auto keepTool = feature.StringParameters.find("keepTool");
      if (tool != feature.StringParameters.end()
          && (keepTool == feature.StringParameters.end() || keepTool->second != "true"))
        replayedBodies.erase(tool->second);
    }
  }

  std::set<std::string> remainingBodies;
  for (const auto& [remainingId, unused] : myBodies)
    if (remainingId != bodyId) remainingBodies.insert(remainingId);
  if (replayedBodies != remainingBodies)
    throw CadError("BODY_IN_USE", "This body is retained by another body's feature history. Delete the dependent result first.");

  myShapeTool->RemoveShape(body->second.Label, true);
  myProperties.RemoveBody(bodyId);
  myBodies.erase(body);
  myFeatures.erase(std::remove_if(myFeatures.begin(), myFeatures.end(),
    [&](const FeatureNode& feature) { return requiredFeatures.find(feature.Id) == requiredFeatures.end(); }),
    myFeatures.end());
  InvalidateMissingCoordinateSources(myCoordinateSystems,myFeatures);

  ++myRevision;
  if (myActiveBodyId == bodyId)
  {
    myActiveBodyId.clear();
    for (auto feature = myFeatures.rbegin(); feature != myFeatures.rend() && myActiveBodyId.empty(); ++feature)
      for (auto output = feature->OutputBodies.rbegin(); output != feature->OutputBodies.rend(); ++output)
        if (myBodies.find(*output) != myBodies.end()) { myActiveBodyId = *output; break; }
    if (myActiveBodyId.empty() && !myBodies.empty()) myActiveBodyId = myBodies.begin()->first;
  }
  persistMetadata();
  return View(requestId);
}

void CadDocument::validatePropertyTarget(const std::string& kind, const std::string& bodyId,
                                         const std::string& topologyId) const
{
  const BodyRecord& body = bodyOrActive(bodyId);
  if (kind == "body")
  {
    if (!topologyId.empty()) throw CadError("INVALID_PROPERTY_TARGET", "Body properties cannot have a topologyId.");
    return;
  }

  ShapeSerializer topology(body.Shape, body.TopologyRevision, body.Id);
  if (kind == "face")
  {
    const int index = topology.FaceIndexFromId(topologyId);
    if (index < 1 || index > topology.Faces().Extent())
      throw CadError("FACE_NOT_FOUND", "The selected face does not exist in this topology revision.");
    return;
  }
  if (kind == "edge")
  {
    const int index = topology.EdgeIndexFromId(topologyId);
    if (index < 1 || index > topology.Edges().Extent())
      throw CadError("EDGE_NOT_FOUND", "The selected edge does not exist in this topology revision.");
    return;
  }
  throw CadError("INVALID_PROPERTY_TARGET", "Property target kind must be body, face or edge.");
}

std::string CadDocument::SetProperty(const std::string& requestId, const int expectedRevision,
                                     const std::string& kind, const std::string& bodyId,
                                     const std::string& topologyId, const std::string& key,
                                     const std::string& type, const JsonValue& value)
{
  if (expectedRevision != myRevision)
    throw CadError("STALE_REVISION", "Document revision is stale. Reload before editing properties.");
  validatePropertyTarget(kind, bodyId, topologyId);
  const BodyRecord& body = bodyOrActive(bodyId);
  myProperties.Set(kind, body.Id, topologyId, key, type, value);
  ++myRevision;
  persistMetadata();
  return responsePrefix(requestId) + ",\"propertyRecords\":"
       + myProperties.ToJson(kind, body.Id, topologyId) + "}";
}

std::string CadDocument::DeleteProperty(const std::string& requestId, const int expectedRevision,
                                        const std::string& kind, const std::string& bodyId,
                                        const std::string& topologyId, const std::string& key)
{
  if (expectedRevision != myRevision)
    throw CadError("STALE_REVISION", "Document revision is stale. Reload before editing properties.");
  validatePropertyTarget(kind, bodyId, topologyId);
  const BodyRecord& body = bodyOrActive(bodyId);
  const bool deleted = myProperties.Delete(kind, body.Id, topologyId, key);
  if (deleted)
  {
    ++myRevision;
    persistMetadata();
  }
  return responsePrefix(requestId) + ",\"deleted\":" + (deleted ? "true" : "false")
       + ",\"propertyRecords\":" + myProperties.ToJson(kind, body.Id, topologyId) + "}";
}

std::string CadDocument::ListProperties(const std::string& requestId, const std::string& kind,
                                        const std::string& bodyId, const std::string& topologyId) const
{
  return responsePrefix(requestId) + ",\"propertyRecords\":"
       + myProperties.ToJson(kind, bodyId, topologyId) + "}";
}

}
