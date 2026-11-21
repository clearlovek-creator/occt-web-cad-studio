#include "CadDocument.hxx"
#include "BodyDisplayMetadata.hxx"

#include "CadError.hxx"
#include "ShapeSpatial.hxx"
#include "TopologyHistory.hxx"
#include "SolidOrientation.hxx"
#include "ShapeFingerprint.hxx"
#include "SuspendedTopology.hxx"
#include "CoordinateReference.hxx"
#include "../features/PrimitiveBuilder.hxx"
#include "../features/EdgeDetailLimits.hxx"
#include "../features/BooleanBuilder.hxx"
#include "../features/PatternIdentity.hxx"
#include "../features/LoftBuilder.hxx"
#include "../features/SweepBuilder.hxx"
#include "../exchange/StepImport.hxx"
#include "../presentation/ShapeSerializer.hxx"
#include "../presentation/FaceBoundaries.hxx"

#include <BRepAlgoAPI_Common.hxx>
#include <BRepBndLib.hxx>
#include <Bnd_Box.hxx>
#include <BRepAlgoAPI_Section.hxx>
#include <BOPAlgo_Splitter.hxx>
#include <IFSelect_ReturnStatus.hxx>
#include <NCollection_Sequence.hxx>
#include <STEPCAFControl_Reader.hxx>
#include <TDF_Label.hxx>
#include <TDocStd_Application.hxx>
#include <XCAFApp_Application.hxx>
#include <XCAFDoc_DocumentTool.hxx>
#include <XCAFDoc_ShapeTool.hxx>
#include <BRepAlgoAPI_Cut.hxx>
#include <BRepBuilderAPI_MakeFace.hxx>
#include <BRepBuilderAPI_MakeEdge.hxx>
#include <BRepBuilderAPI_MakePolygon.hxx>
#include <BRepBuilderAPI_MakeWire.hxx>
#include <BRepOffsetAPI_ThruSections.hxx>
#include <BRepOffsetAPI_MakeOffsetShape.hxx>
#include <BRepOffsetAPI_DraftAngle.hxx>
#include <BRepOffsetAPI_MakeThickSolid.hxx>
#include <GeomAbs_JoinType.hxx>
#include <Precision.hxx>
#include <BRepAlgoAPI_Fuse.hxx>
#include <BRepBuilderAPI_Transform.hxx>
#include <gp_Ax1.hxx>
#include <BRepBuilderAPI_GTransform.hxx>
#include <BRepBndLib.hxx>
#include <Bnd_Box.hxx>
#include <BRepCheck_Analyzer.hxx>
#include <BRepFilletAPI_MakeFillet.hxx>
#include <BRepFilletAPI_MakeChamfer.hxx>
#include <BRepPrimAPI_MakeBox.hxx>
#include <BRepPrimAPI_MakeCone.hxx>
#include <BRepPrimAPI_MakeCylinder.hxx>
#include <BRepPrimAPI_MakeSphere.hxx>
#include <BRepPrimAPI_MakeTorus.hxx>
#include <BRepPrimAPI_MakePrism.hxx>
#include <BRepPrimAPI_MakeWedge.hxx>
#include <BRepPrimAPI_MakeRevol.hxx>
#include <TopoDS_Wire.hxx>
#include <TopoDS.hxx>
#include <BRepAdaptor_Surface.hxx>
#include <GeomAbs_SurfaceType.hxx>
#include <TopAbs_ShapeEnum.hxx>
#include <TopExp_Explorer.hxx>
#include <ShapeUpgrade_UnifySameDomain.hxx>
#include <gp_Ax1.hxx>
#include <gp_Ax2.hxx>
#include <gp_Circ.hxx>
#include <gp_Dir.hxx>
#include <gp_Pnt.hxx>
#include <gp_Trsf.hxx>
#include <gp_GTrsf.hxx>
#include <gp_Mat.hxx>
#include <gp_Vec.hxx>

#include <algorithm>
#include <filesystem>
#include <cmath>
#include <map>
#include <set>
#include <sstream>
#include <vector>

namespace
{
using occweb::CadError;
using occweb::FeatureNode;
using occweb::JsonValue;
using occweb::ShapeSerializer;

struct ReplayBody
{
  TopoDS_Shape Shape;
  std::string SourceFeatureId;
  bool Affected = false;
  bool ComplexTopology = false;
  bool HasMetadata = false;
  std::string Name;
  bool Visible = true;
  std::string Color = "#7b91aa";
  std::string Material;
  occweb::TopologyNames Names;
  double Opacity = 1.0;
};

void applyStoredMetadata(ReplayBody& body, const FeatureNode& feature,
                         const std::string& role, const std::string& bodyId)
{
  const std::string prefix = role + "." + bodyId + ".";
  const auto name = feature.StringParameters.find(prefix + "name");
  if (name == feature.StringParameters.end()) return;
  body.HasMetadata = true;
  body.Name = name->second;
  const auto visible = feature.StringParameters.find(prefix + "visible");
  body.Visible = visible == feature.StringParameters.end() || visible->second == "true";
  const auto color = feature.StringParameters.find(prefix + "color");
  if (color != feature.StringParameters.end()) body.Color = color->second;
  const auto material = feature.StringParameters.find(prefix + "material");
  if (material != feature.StringParameters.end()) body.Material = material->second;
  if(const auto opacity=occweb::StoredBodyOpacity(feature,role,bodyId))body.Opacity=*opacity;
}

double number(const FeatureNode& feature, const std::string& key, const double fallback = 0.0)
{
  const auto found = feature.NumberParameters.find(key);
  return found == feature.NumberParameters.end() ? fallback : found->second;
}

std::string textParameter(const FeatureNode& feature, const std::string& key)
{
  const auto found = feature.StringParameters.find(key);
  if (found == feature.StringParameters.end())
    throw CadError("INVALID_FEATURE_GRAPH", "Feature is missing stored parameter: " + key);
  return found->second;
}

void positive(const double value, const std::string& label)
{
  if (!std::isfinite(value) || value <= 0.0 || value > 10000.0)
    throw CadError("INVALID_PARAMETER", label + " must be between 0 and 10000 mm.");
}

TopoDS_Face analyticFace(const TopoDS_Shape& source, const GeomAbs_SurfaceType type,
                         const std::string& label)
{
  for (TopExp_Explorer explorer(source, TopAbs_FACE); explorer.More(); explorer.Next())
  {
    const TopoDS_Face face = TopoDS::Face(explorer.Current());
    if (BRepAdaptor_Surface(face).GetType() == type) return face;
  }
  throw CadError("INVALID_RESULT", "OCCT could not isolate the " + label + " surface during recompute.");
}

gp_Pnt origin(const FeatureNode& feature)
{
  const double x = number(feature, "originX", number(feature, "x", 0.0));
  const double y = number(feature, "originY", number(feature, "y", 0.0));
  const double z = number(feature, "originZ", number(feature, "z", 0.0));
  if (!std::isfinite(x) || !std::isfinite(y) || !std::isfinite(z))
    throw CadError("INVALID_PARAMETER", "Feature origin must contain finite coordinates.");
  return gp_Pnt(x, y, z);
}

void requireValidShape(const TopoDS_Shape& shape, const std::string& message)
{
  if (shape.IsNull() || !BRepCheck_Analyzer(shape).IsValid())
    throw CadError("INVALID_RESULT", message);
}

std::vector<TopoDS_Shape> buildImportedShapes(const FeatureNode& feature)
{
  if (feature.OutputBodies.empty())
    throw CadError("INVALID_FEATURE_GRAPH", "STEP import feature must produce at least one body.");
  const auto sourceParameter = feature.StringParameters.find("sourcePath");
  if (sourceParameter == feature.StringParameters.end() || sourceParameter->second.empty())
    throw CadError("STEP_REPLAY_SOURCE_MISSING", "This STEP import has no retained source. Reimport the STEP file before recompute.");
  const std::filesystem::path sourcePath = std::filesystem::u8path(sourceParameter->second);
  if (!std::filesystem::is_regular_file(sourcePath))
    throw CadError("STEP_REPLAY_SOURCE_MISSING", "The retained STEP source is unavailable for recompute.");

  const auto version=feature.NumberParameters.find("decompositionVersion");
  if(version!=feature.NumberParameters.end()&&version->second!=1.0&&version->second!=2.0)throw CadError("STEP_IMPORT_VERSION_UNSUPPORTED","Unsupported STEP decomposition version.");
  const int policy=version==feature.NumberParameters.end()?1:static_cast<int>(version->second);
  const auto fingerprint=feature.StringParameters.find("sourceFingerprint");
  if(policy==2&&(fingerprint==feature.StringParameters.end()||fingerprint->second.empty()||textParameter(feature,"sourceFingerprintAlgorithm")!="sha256-chain-1m-v1"))throw CadError("INVALID_FEATURE_GRAPH","Versioned STEP source fingerprint is missing or unsupported.");
  const auto imported=occweb::ReadStepParts(sourcePath.u8string(),policy,fingerprint==feature.StringParameters.end()?"":fingerprint->second);
  std::vector<TopoDS_Shape> shapes;
  for (const auto& part : imported.Parts)
  {
    if(policy==1)requireValidShape(part.Shape,"The retained STEP source produced an invalid shape.");
    shapes.push_back(part.Shape);
  }
  if (shapes.size() != feature.OutputBodies.size())
    throw CadError("STEP_REPLAY_SOURCE_MISMATCH", "The retained STEP source no longer matches the imported body count.");
  return shapes;
}

TopoDS_Shape applyTransform(const TopoDS_Shape& input, const FeatureNode& feature, occweb::TopologyNames* names=nullptr)
{
  if (feature.Type == "transform.scale_non_uniform")
  {
    const double sx = number(feature, "factorX", 1.0), sy = number(feature, "factorY", 1.0), sz = number(feature, "factorZ", 1.0);
    const double ox = number(feature, "originX"), oy = number(feature, "originY"), oz = number(feature, "originZ");
    gp_GTrsf transform;
    transform.SetVectorialPart(gp_Mat(sx,0,0, 0,sy,0, 0,0,sz));
    transform.SetTranslationPart(gp_XYZ(ox*(1-sx), oy*(1-sy), oz*(1-sz)));
    BRepBuilderAPI_GTransform builder(input, transform, true); builder.Build();
    if (!builder.IsDone()) throw CadError("BUILD_FAILED", "Non-uniform scale failed during recompute.");
    const TopoDS_Shape result = builder.Shape();
    requireValidShape(result, "Non-uniform scale result is invalid during recompute.");
    if(names)*names=occweb::TopologyNaming::Propagate(input,*names,result,builder);
    return result;
  }

  gp_Trsf transform;
  if (feature.Type == "transform.translate" || feature.Type == "transform.copy" || feature.Type == "transform.align")
    transform.SetTranslation(gp_Vec(number(feature, "dx"), number(feature, "dy"), number(feature, "dz")));
  else if (feature.Type == "transform.rotate")
  {
    const double x = number(feature, "axisX", 0.0), y = number(feature, "axisY", 0.0), z = number(feature, "axisZ", 1.0);
    const double angle = number(feature, "angleDegrees");
    if (x*x + y*y + z*z < 1.0e-24 || !std::isfinite(angle)) throw CadError("INVALID_PARAMETER", "Stored rotation parameters are invalid.");
    transform.SetRotation(gp_Ax1(origin(feature), gp_Dir(x, y, z)), angle * 3.14159265358979323846 / 180.0);
  }
  else if (feature.Type == "transform.mirror")
  {
    const std::string mode = feature.StringParameters.count("mode") ? textParameter(feature, "mode") : "plane";
    if (mode == "point") transform.SetMirror(origin(feature));
    else
    {
      const double x = number(feature, "normalX", 1.0), y = number(feature, "normalY", 0.0), z = number(feature, "normalZ", 0.0);
      if (x*x + y*y + z*z < 1.0e-24) throw CadError("INVALID_PARAMETER", "Stored mirror parameters are invalid.");
      if (mode == "axis") transform.SetMirror(gp_Ax1(origin(feature), gp_Dir(x,y,z)));
      else transform.SetMirror(gp_Ax2(origin(feature), gp_Dir(x,y,z)));
    }
  }
  else if (feature.Type == "transform.scale")
  {
    const double factor = number(feature, "factor");
    if (!std::isfinite(factor) || factor <= 0.0 || factor > 1000.0) throw CadError("INVALID_PARAMETER", "Stored scale factor is invalid.");
    transform.SetScale(origin(feature), factor);
  }
  else if (feature.Type == "transform.coordinate")
  {
    transform.SetValues(number(feature,"m11"),number(feature,"m12"),number(feature,"m13"),number(feature,"m14"),
                        number(feature,"m21"),number(feature,"m22"),number(feature,"m23"),number(feature,"m24"),
                        number(feature,"m31"),number(feature,"m32"),number(feature,"m33"),number(feature,"m34"));
  }
  else throw CadError("UNSUPPORTED_RECOMPUTE", "Unsupported Transform feature: " + feature.Type);
  BRepBuilderAPI_Transform builder(input, transform, true); builder.Build();
  if (!builder.IsDone()) throw CadError("BUILD_FAILED", "A Transform failed during recompute.");
  const TopoDS_Shape result = builder.Shape();
  requireValidShape(result, "A transformed result is invalid during recompute.");
  if(names)*names=occweb::TopologyNaming::Propagate(input,*names,result,builder);
  return result;
}
int topologyIndex(const std::string& id, const std::string& prefix)
{
  if (id.rfind(prefix + '-', 0) != 0) return 0;
  const std::size_t separator = id.rfind('-');
  if (separator == std::string::npos) return 0;
  try { return std::stoi(id.substr(separator + 1)); }
  catch (...) { return 0; }
}

void prepareSelection(FeatureNode& feature, const ReplayBody& source)
{
  const std::string kind = feature.StringParameters.count("edgeId") ? "edge" : "face";
  const std::string field = kind + "Id";
  const auto selected = feature.StringParameters.find(field);
  if (selected == feature.StringParameters.end() || selected->second.empty()) return;
  const std::string key = "selection." + field;
  auto stored = feature.StringParameters.find(key);
  if (stored == feature.StringParameters.end())
  {
    if (source.Affected)
      throw CadError("FEATURE_SELECTION_UNVERIFIED", "This legacy feature has no persistent input selection. Its upstream geometry changed; reselect or recreate it before recomputing.");
    stored = feature.StringParameters.emplace(key, occweb::TopologyNaming::CaptureSelection(
      source.Shape, source.Names, kind, topologyIndex(selected->second, kind))).first;
  }
  const int index = occweb::TopologyNaming::ResolveSelection(source.Shape, source.Names, stored->second);
  // Only the local replay copy gets a resolved enumeration index. The stored
  // reference remains immutable and is resolved again for each input state.
  selected->second = kind + "-0-" + std::to_string(index);
}

TopoDS_Shape applyFillet(const TopoDS_Shape& input, const FeatureNode& feature, occweb::TopologyNames* names)
{
  const double radius = number(feature, "radius");
  if (!std::isfinite(radius) || radius <= 0.0 || radius > 1000.0)
    throw CadError("INVALID_PARAMETER", "Fillet radius must be between 0 and 1000 mm.");
  // Use the same kernel/result validation as initial creation. Global plate
  // thickness is unrelated to the local cross-section of a vertical fillet.
  ShapeSerializer topology(input, 0, "recompute");
  const int edgeIndex = topologyIndex(textParameter(feature, "edgeId"), "edge");
  if (edgeIndex < 1 || edgeIndex > topology.Edges().Extent())
    throw CadError("EDGE_NOT_FOUND", "The stored Fillet edge cannot be resolved during recompute.");
  occweb::ValidatePlanarEdgeDetail(input,TopoDS::Edge(topology.Edges()(edgeIndex)),radius,true);
  BRepFilletAPI_MakeFillet builder(input);
  builder.Add(radius, TopoDS::Edge(topology.Edges()(edgeIndex)));
  builder.Build();
  if (!builder.IsDone()) throw CadError("BUILD_FAILED", "OCCT could not rebuild the Fillet. Try a smaller radius.");
  const TopoDS_Shape result = builder.Shape();
  requireValidShape(result, "The rebuilt Fillet is not a valid shape.");
  if (names) *names = occweb::TopologyNaming::FeatureResult(input, *names, result, builder,feature.Id);
  return result;
}

TopoDS_Shape applyChamfer(const TopoDS_Shape& input, const FeatureNode& feature, occweb::TopologyNames* names)
{
  const double distance = number(feature, "distance");
  if (!std::isfinite(distance) || distance <= 0.0 || distance > 1000.0)
    throw CadError("INVALID_PARAMETER", "Chamfer distance must be between 0 and 1000 mm.");
  ShapeSerializer topology(input, 0, "recompute");
  const int edgeIndex = topologyIndex(textParameter(feature, "edgeId"), "edge");
  if (edgeIndex < 1 || edgeIndex > topology.Edges().Extent())
    throw CadError("EDGE_NOT_FOUND", "The stored Chamfer edge cannot be resolved during recompute.");
  occweb::ValidatePlanarEdgeDetail(input,TopoDS::Edge(topology.Edges()(edgeIndex)),distance,false);
  BRepFilletAPI_MakeChamfer builder(input);
  builder.Add(distance, TopoDS::Edge(topology.Edges()(edgeIndex)));
  builder.Build();
  if (!builder.IsDone()) throw CadError("BUILD_FAILED", "OCCT could not rebuild the Chamfer. Try a smaller distance.");
  const TopoDS_Shape result = builder.Shape();
  requireValidShape(result, "The rebuilt Chamfer is not a valid shape.");
  if (names) *names = occweb::TopologyNaming::FeatureResult(input, *names, result, builder,feature.Id);
  return result;
}
TopoDS_Shape applyDraft(const TopoDS_Shape& input, const FeatureNode& feature,occweb::TopologyNames* names)
{
  const double angleDegrees = number(feature, "angleDegrees");
  if (!std::isfinite(angleDegrees) || std::abs(angleDegrees) < 1.0e-8 || std::abs(angleDegrees) >= 89.0)
    throw CadError("INVALID_PARAMETER", "Draft angle must be non-zero and smaller than 89 degrees.");
  const double neutralOriginX = number(feature, "neutralOriginX");
  const double neutralOriginY = number(feature, "neutralOriginY");
  const double neutralOriginZ = number(feature, "neutralOriginZ");
  const double neutralNormalX = number(feature, "neutralNormalX");
  const double neutralNormalY = number(feature, "neutralNormalY");
  const double neutralNormalZ = number(feature, "neutralNormalZ", 1.0);
  const double directionX = number(feature, "directionX", neutralNormalX);
  const double directionY = number(feature, "directionY", neutralNormalY);
  const double directionZ = number(feature, "directionZ", neutralNormalZ);
  if (neutralNormalX * neutralNormalX + neutralNormalY * neutralNormalY + neutralNormalZ * neutralNormalZ < 1.0e-24
      || directionX * directionX + directionY * directionY + directionZ * directionZ < 1.0e-24)
    throw CadError("INVALID_PARAMETER", "Stored Draft directions are invalid.");
  ShapeSerializer topology(input, 0, "recompute");
  const int faceIndex = topologyIndex(textParameter(feature, "faceId"), "face");
  if (faceIndex < 1 || faceIndex > topology.Faces().Extent())
    throw CadError("FACE_NOT_FOUND", "The stored Draft Face cannot be resolved during recompute.");
  const TopoDS_Face face = TopoDS::Face(topology.Faces()(faceIndex));
  const GeomAbs_SurfaceType surfaceType = BRepAdaptor_Surface(face).GetType();
  if (surfaceType != GeomAbs_Plane && surfaceType != GeomAbs_Cylinder && surfaceType != GeomAbs_Cone)
    throw CadError("INVALID_FACE", "Draft supports planar, cylindrical or conical Faces only.");
  BRepOffsetAPI_DraftAngle builder(input);
  builder.Add(face, gp_Dir(directionX, directionY, directionZ),
              angleDegrees * 3.14159265358979323846 / 180.0,
              gp_Pln(gp_Pnt(neutralOriginX, neutralOriginY, neutralOriginZ),
                     gp_Dir(neutralNormalX, neutralNormalY, neutralNormalZ)), true);
  if (!builder.AddDone()) throw CadError("BUILD_FAILED", "OCCT could not rebuild the Draft.");
  builder.Build();
  if (!builder.IsDone()) throw CadError("BUILD_FAILED", "OCCT could not finish the Draft during recompute.");
  const TopoDS_Shape result = builder.Shape();
  requireValidShape(result, "The rebuilt Draft is not a valid shape.");
  if(names)*names=occweb::TopologyNaming::FeatureResult(input,*names,result,builder,feature.Id);
  return result;
}TopoDS_Shape applyLinearPattern(const TopoDS_Shape& input, const FeatureNode& feature, const int index,occweb::TopologyNames* names)
{
  if (index == 0) return input;
  const double spacing = number(feature, "spacing");
  const double directionX = number(feature, "directionX", 1.0);
  const double directionY = number(feature, "directionY");
  const double directionZ = number(feature, "directionZ");
  if (!std::isfinite(spacing) || spacing == 0.0 || std::abs(spacing) > 100000.0
      || directionX * directionX + directionY * directionY + directionZ * directionZ < 1.0e-24)
    throw CadError("INVALID_PARAMETER", "Stored linear pattern parameters are invalid.");
  gp_Trsf transform;
  transform.SetTranslation(gp_Vec(gp_Dir(directionX, directionY, directionZ)) * spacing * index);
  BRepBuilderAPI_Transform builder(input, transform, true);
  builder.Build();
  if (!builder.IsDone()) throw CadError("BUILD_FAILED", "OCCT could not rebuild a linear pattern instance.");
  const TopoDS_Shape result = builder.Shape();
  requireValidShape(result, "The rebuilt linear pattern instance is invalid.");
  if(names)*names=occweb::TopologyNaming::Instance(occweb::TopologyNaming::Propagate(input,*names,result,builder),feature.Id,occweb::PatternSlot(feature,index));
  return result;
}TopoDS_Shape applyCircularPattern(const TopoDS_Shape& input, const FeatureNode& feature, const int index,occweb::TopologyNames* names)
{
  if (index == 0) return input;
  const double angleDegrees = number(feature, "angleDegrees");
  const double originX = number(feature, "originX");
  const double originY = number(feature, "originY");
  const double originZ = number(feature, "originZ");
  const double axisX = number(feature, "axisX", 1.0);
  const double axisY = number(feature, "axisY");
  const double axisZ = number(feature, "axisZ");
  if (!std::isfinite(angleDegrees) || std::abs(angleDegrees) < 1.0e-8 || std::abs(angleDegrees) > 36000.0
      || axisX * axisX + axisY * axisY + axisZ * axisZ < 1.0e-24)
    throw CadError("INVALID_PARAMETER", "Stored circular pattern parameters are invalid.");
  gp_Trsf transform;
  transform.SetRotation(gp_Ax1(gp_Pnt(originX, originY, originZ), gp_Dir(axisX, axisY, axisZ)),
                        angleDegrees * 3.14159265358979323846 / 180.0 * index);
  BRepBuilderAPI_Transform builder(input, transform, true);
  builder.Build();
  if (!builder.IsDone()) throw CadError("BUILD_FAILED", "OCCT could not rebuild a circular pattern instance.");
  const TopoDS_Shape result = builder.Shape();
  requireValidShape(result, "The rebuilt circular pattern instance is invalid.");
  if(names)*names=occweb::TopologyNaming::Instance(occweb::TopologyNaming::Propagate(input,*names,result,builder),feature.Id,occweb::PatternSlot(feature,index));
  return result;
}TopoDS_Shape applyMirrorPattern(const TopoDS_Shape& input, const FeatureNode& feature, const int index,occweb::TopologyNames* names)
{
  if (index == 0) return input;
  const double originX = number(feature, "originX");
  const double originY = number(feature, "originY");
  const double originZ = number(feature, "originZ");
  const double normalX = number(feature, "normalX", 1.0);
  const double normalY = number(feature, "normalY");
  const double normalZ = number(feature, "normalZ");
  if (normalX * normalX + normalY * normalY + normalZ * normalZ < 1.0e-24)
    throw CadError("INVALID_PARAMETER", "Stored mirror plane normal is invalid.");
  gp_Trsf transform;
  transform.SetMirror(gp_Ax2(gp_Pnt(originX, originY, originZ), gp_Dir(normalX, normalY, normalZ)));
  BRepBuilderAPI_Transform builder(input, transform, true);
  builder.Build();
  if (!builder.IsDone()) throw CadError("BUILD_FAILED", "OCCT could not rebuild the Mirror Pattern.");
  const TopoDS_Shape result = builder.Shape();
  requireValidShape(result, "The rebuilt Mirror Pattern instance is invalid.");
  if(names)*names=occweb::TopologyNaming::Instance(occweb::TopologyNaming::Propagate(input,*names,result,builder),feature.Id,occweb::PatternSlot(feature,index));
  return result;
}TopoDS_Shape applyRevolve(const TopoDS_Shape& input, const FeatureNode& feature,occweb::TopologyNames* names)
{
  ShapeSerializer topology(input, 0, "recompute");
  const int faceIndex = topologyIndex(textParameter(feature, "faceId"), "face");
  if (faceIndex < 1 || faceIndex > topology.Faces().Extent())
    throw CadError("FACE_NOT_FOUND", "The stored Revolve Face cannot be resolved during recompute.");
  const TopoDS_Face face = TopoDS::Face(topology.Faces()(faceIndex));
  const double angleDegrees = number(feature, "angleDegrees", 360.0);
  const double originX = number(feature, "originX");
  const double originY = number(feature, "originY");
  const double originZ = number(feature, "originZ");
  const double axisX = number(feature, "axisX");
  const double axisY = number(feature, "axisY");
  const double axisZ = number(feature, "axisZ", 1.0);
  if (!std::isfinite(angleDegrees) || std::abs(angleDegrees) < 1.0e-8 || std::abs(angleDegrees) > 360.0
      || axisX * axisX + axisY * axisY + axisZ * axisZ < 1.0e-24)
    throw CadError("INVALID_PARAMETER", "Stored Revolve parameters are invalid.");
  BRepPrimAPI_MakeRevol builder(face,
    gp_Ax1(gp_Pnt(originX, originY, originZ), gp_Dir(axisX, axisY, axisZ)),
    angleDegrees * 3.14159265358979323846 / 180.0, true);
  builder.Build();
  if (!builder.IsDone()) throw CadError("BUILD_FAILED", "OCCT could not rebuild the Revolve.");
  const TopoDS_Shape result = builder.Shape();
  requireValidShape(result, "The rebuilt Revolve is not a valid shape.");
  if(names)*names=occweb::TopologyNaming::SweepResult(face,occweb::TopologyNaming::Restrict(input,*names,face),result,builder,feature.Id,builder.FirstShape(),builder.LastShape());
  return result;
}
TopoDS_Shape applySweep(const TopoDS_Shape& input, const FeatureNode& feature,occweb::TopologyNames* names)
{
  TopoDS_Shape profile = input;
  const std::string faceId = textParameter(feature, "faceId");
  if (!faceId.empty()) {
    ShapeSerializer topology(input, 0, "recompute");
    const int index = topologyIndex(faceId, "face");
    if (index < 1 || index > topology.Faces().Extent()) throw CadError("FACE_NOT_FOUND", "The stored sweep Face cannot be resolved during recompute.");
    profile = TopoDS::Face(topology.Faces()(index));
  }
  const double dx = number(feature, "pathX", number(feature, "dx"));
  const double dy = number(feature, "pathY", number(feature, "dy"));
  const double dz = number(feature, "pathZ", number(feature, "dz", 10.0));
  if (!std::isfinite(dx) || !std::isfinite(dy) || !std::isfinite(dz) || dx * dx + dy * dy + dz * dz < 1.0e-16)
    throw CadError("INVALID_PARAMETER", "Stored sweep path vector is invalid.");
  BRepPrimAPI_MakePrism builder(profile, gp_Vec(dx, dy, dz), true);
  builder.Build();
  if (!builder.IsDone()) throw CadError("BUILD_FAILED", "The sweep/pipe could not be rebuilt.");
  const TopoDS_Shape result = builder.Shape();
  requireValidShape(result, "The rebuilt sweep/pipe is invalid.");
  if(names)*names=occweb::TopologyNaming::SweepResult(profile,occweb::TopologyNaming::Restrict(input,*names,profile),result,builder,feature.Id,builder.FirstShape(),builder.LastShape());
  return result;
}

TopoDS_Shape applyRectangularPattern(const TopoDS_Shape& input, const FeatureNode& feature, const int index,occweb::TopologyNames* names)
{
  if (index == 0) return input;
  const int countX = static_cast<int>(std::round(number(feature, "countX", 1.0)));
  const double spacingX = number(feature, "spacingX");
  const double spacingY = number(feature, "spacingY");
  const double directionX = number(feature, "directionX", 1.0);
  const double directionY = number(feature, "directionY");
  const double directionZ = number(feature, "directionZ");
  const double direction2X = number(feature, "direction2X");
  const double direction2Y = number(feature, "direction2Y", 1.0);
  const double direction2Z = number(feature, "direction2Z");
  if (countX < 1 || !std::isfinite(spacingX) || !std::isfinite(spacingY) || spacingX == 0.0 || spacingY == 0.0
      || std::abs(spacingX) > 100000.0 || std::abs(spacingY) > 100000.0
      || directionX * directionX + directionY * directionY + directionZ * directionZ < 1.0e-24
      || direction2X * direction2X + direction2Y * direction2Y + direction2Z * direction2Z < 1.0e-24)
    throw CadError("INVALID_PARAMETER", "Stored rectangular pattern parameters are invalid.");
  const int row = index / countX;
  const int column = index % countX;
  gp_Trsf transform;
  transform.SetTranslation(gp_Vec(gp_Dir(directionX, directionY, directionZ)) * spacingX * column
                            + gp_Vec(gp_Dir(direction2X, direction2Y, direction2Z)) * spacingY * row);
  BRepBuilderAPI_Transform builder(input, transform, true);
  builder.Build();
  if (!builder.IsDone()) throw CadError("BUILD_FAILED", "OCCT could not rebuild a rectangular pattern instance.");
  const TopoDS_Shape result = builder.Shape();
  requireValidShape(result, "The rebuilt rectangular pattern instance is invalid.");
  if(names)*names=occweb::TopologyNaming::Instance(occweb::TopologyNaming::Propagate(input,*names,result,builder),feature.Id,occweb::PatternSlot(feature,index));
  return result;
}
TopoDS_Shape applyOffsetDetail(const TopoDS_Shape& input, const FeatureNode& feature,occweb::TopologyNames* names)
{
  if (feature.Type == "detail.offset")
  {
    const double distance = number(feature, "distance");
    if (!std::isfinite(distance) || distance == 0.0 || std::abs(distance) > 1000.0)
      throw CadError("INVALID_PARAMETER", "Offset distance must be non-zero and within 1000 mm.");
    BRepOffsetAPI_MakeOffsetShape builder;
    builder.PerformByJoin(input, distance, Precision::Confusion(), BRepOffset_Skin,
                          false, false, GeomAbs_Arc, true);
    if (!builder.IsDone()) throw CadError("BUILD_FAILED", "OCCT could not rebuild the Offset.");
    const TopoDS_Shape result = builder.Shape();
    requireValidShape(result, "The rebuilt Offset is not a valid shape.");
    if(names)*names=occweb::TopologyNaming::FeatureResult(input,*names,result,builder,feature.Id);
    return result;
  }

  const double thickness = number(feature, "thickness");
  if (!std::isfinite(thickness) || thickness <= 0.0 || thickness > 1000.0)
    throw CadError("INVALID_PARAMETER", "Thickness must be positive and within 1000 mm.");
  ShapeSerializer topology(input, 0, "recompute");
  const int faceIndex = topologyIndex(textParameter(feature, "faceId"), "face");
  if (faceIndex < 1 || faceIndex > topology.Faces().Extent())
    throw CadError("FACE_NOT_FOUND", "The stored Face cannot be resolved during recompute.");
  const TopoDS_Face face = TopoDS::Face(topology.Faces()(faceIndex));
  const auto storedBoolean = [&](const std::string& key, const bool fallback)
  {
    const auto value = feature.StringParameters.find(key);
    return value == feature.StringParameters.end() ? fallback : value->second == "true";
  };
  BRepOffsetAPI_MakeThickSolid builder;
  if (feature.Type == "detail.shell")
  {
    NCollection_List<TopoDS_Shape> closingFaces;
    closingFaces.Append(face);
    const bool inward = storedBoolean("inward", true);
    builder.MakeThickSolidByJoin(input, closingFaces, inward ? -thickness : thickness,
                                 Precision::Confusion(), BRepOffset_Skin,
                                 false, false, GeomAbs_Arc, true);
  }
  else if (feature.Type == "detail.thicken")
  {
    builder.MakeThickSolidBySimple(face, storedBoolean("reverse", false) ? -thickness : thickness);
  }
  else
  {
    throw CadError("UNSUPPORTED_RECOMPUTE", "Unsupported offset detail feature: " + feature.Type);
  }
  if (!builder.IsDone()) throw CadError("BUILD_FAILED", "OCCT could not rebuild " + feature.Type + ".");
  const TopoDS_Shape result = feature.Type == "detail.thicken" ? occweb::OrientClosedSolidResult(builder.Shape()) : builder.Shape();
  requireValidShape(result, "The rebuilt offset detail is not a valid shape.");
  if(names)*names=feature.Type=="detail.thicken"
    ?occweb::TopologyNaming::FeatureResult(face,occweb::TopologyNaming::Restrict(input,*names,face),result,builder,feature.Id)
    :occweb::TopologyNaming::FeatureResult(input,*names,result,builder,feature.Id,{face});
  return result;
}
std::vector<std::string> splitBodyIds(const std::string& value)
{
  std::vector<std::string> result;
  std::stringstream stream(value);
  std::string item;
  while (std::getline(stream, item, ',')) if (!item.empty()) result.push_back(item);
  return result;
}


std::vector<TopoDS_Shape> replayBooleanOutputs(const TopoDS_Shape& result, const bool splitResults)
{
  if (!splitResults) return {result};
  std::vector<TopoDS_Shape> solids;
  for (TopExp_Explorer explorer(result, TopAbs_SOLID); explorer.More(); explorer.Next())
    solids.push_back(explorer.Current());
  return solids.size() > 1 ? solids : std::vector<TopoDS_Shape>{result};
}

bool isBooleanType(const std::string& type)
{
  static const std::set<std::string> supported = {
    "boolean.fuse", "boolean.cut", "boolean.common", "boolean.section",
    "boolean.split", "boolean.partition", "boolean.fragments", "boolean.imprint"
  };
  return supported.find(type) != supported.end();
}

std::string joinBodyIds(const std::vector<std::string>& values)
{
  std::ostringstream output;
  for (std::size_t index = 0; index < values.size(); ++index)
  {
    if (index != 0) output << ',';
    output << values[index];
  }
  return output.str();
}

bool storedFlag(const FeatureNode& feature, const std::string& key, const bool fallback)
{
  const auto found = feature.StringParameters.find(key);
  return found == feature.StringParameters.end() ? fallback : found->second == "true";
}

std::vector<std::string> storedBodyIds(const FeatureNode& feature,
                                       const std::string& pluralKey,
                                       const std::string& singularKey)
{
  const auto plural = feature.StringParameters.find(pluralKey);
  return plural == feature.StringParameters.end()
    ? std::vector<std::string>{textParameter(feature, singularKey)}
    : splitBodyIds(plural->second);
}

void updateBooleanDefinition(FeatureNode& feature, const JsonValue& parameters)
{
  static const std::set<std::string> editable = {"operationType", "targetBodies", "toolBodies", "refine"};
  for (const auto& [key, unused] : parameters.AsObject())
    if (editable.find(key) == editable.end())
      throw CadError("INVALID_PARAMETER", "Parameter is not editable for a Boolean feature: " + key);

  const std::string operation = parameters.GetStringOr("operationType", feature.Type);
  if (!isBooleanType(operation))
    throw CadError("INVALID_PARAMETER", "Unsupported Boolean operation type: " + operation);
  if (operation == "boolean.imprint" && !storedFlag(feature, "keepTool", false))
    throw CadError("INVALID_PARAMETER", "Imprint requires a Boolean feature created with Keep Tool enabled.");

  const std::vector<std::string> oldTargets = storedBodyIds(feature, "targetBodies", "targetBody");
  const std::vector<std::string> oldTools = storedBodyIds(feature, "toolBodies", "toolBody");
  const std::vector<std::string> targets = splitBodyIds(parameters.GetStringOr("targetBodies", joinBodyIds(oldTargets)));
  const std::vector<std::string> tools = splitBodyIds(parameters.GetStringOr("toolBodies", joinBodyIds(oldTools)));
  if (targets.empty() || tools.empty())
    throw CadError("INVALID_BOOLEAN_INPUT", "Boolean editing requires at least one Target and one Tool Body.");

  std::vector<std::string> oldInputs = oldTargets;
  oldInputs.insert(oldInputs.end(), oldTools.begin(), oldTools.end());
  std::vector<std::string> newInputs = targets;
  newInputs.insert(newInputs.end(), tools.begin(), tools.end());
  const std::set<std::string> oldSet(oldInputs.begin(), oldInputs.end());
  const std::set<std::string> newSet(newInputs.begin(), newInputs.end());
  if (oldSet.size() != oldInputs.size() || newSet.size() != newInputs.size() || oldSet != newSet)
    throw CadError("INVALID_BOOLEAN_INPUT", "Boolean editing may reassign existing inputs but cannot add, remove or duplicate Bodies.");
  if (oldInputs.size() != feature.InputFeatures.size())
    throw CadError("INVALID_FEATURE_GRAPH", "Boolean input Bodies do not match input Features.");

  std::map<std::string, std::string> sourceFeatures;
  for (std::size_t index = 0; index < oldInputs.size(); ++index)
    sourceFeatures.emplace(oldInputs[index], feature.InputFeatures[index]);
  feature.InputFeatures.clear();
  for (const std::string& id : newInputs) feature.InputFeatures.push_back(sourceFeatures.at(id));
  feature.Type = operation;
  feature.StringParameters["targetBody"] = targets.front();
  feature.StringParameters["toolBody"] = tools.front();
  feature.StringParameters["targetBodies"] = joinBodyIds(targets);
  feature.StringParameters["toolBodies"] = joinBodyIds(tools);
  feature.StringParameters["refine"] = parameters.GetBooleanOr("refine", storedFlag(feature, "refine", true)) ? "true" : "false";
}

std::set<std::string> allowedParameters(const std::string& type)
{
  if (type == "primitive.box") return {"width", "depth", "height", "x", "y", "z"};
  if (type == "primitive.cylinder") return {"radius", "height", "x", "y", "z"};
  if (type == "primitive.cone") return {"radius1", "radius2", "height", "x", "y", "z"};
  if (type == "primitive.sphere") return {"radius", "x", "y", "z"};
  if (type == "primitive.torus") return {"majorRadius", "minorRadius", "x", "y", "z"};
  if (type == "primitive.wedge") return {"width", "depth", "height", "topLength", "x", "y", "z"};
  if (type == "primitive.prism") return {"radius", "height", "sides", "x", "y", "z"};
  if (type == "primitive.pyramid") return {"baseWidth", "baseDepth", "height", "topWidth", "topDepth", "x", "y", "z"};
  if (type == "primitive.tube") return {"outerRadius", "innerRadius", "height", "x", "y", "z"};
  if (type == "surface.rectangle") return {"width", "height", "x", "y", "z"};
  if (type == "surface.disk") return {"radius", "x", "y", "z"};
  if (type == "surface.cylinder") return {"radius", "height", "x", "y", "z"};
  if (type == "surface.cone") return {"radius1", "radius2", "height", "x", "y", "z"};
  if (type == "surface.sphere") return {"radius", "x", "y", "z"};
  if (type == "transform.translate") return {"dx", "dy", "dz"};
  if (type == "transform.rotate") return {"originX", "originY", "originZ", "axisX", "axisY", "axisZ", "angleDegrees"};
  if (type == "transform.mirror") return {"originX", "originY", "originZ", "normalX", "normalY", "normalZ"};
  if (type == "transform.scale") return {"originX", "originY", "originZ", "factor"};
  if (type == "transform.scale_non_uniform") return {"originX", "originY", "originZ", "factorX", "factorY", "factorZ"};
  if (type == "transform.copy" || type == "transform.align") return {"dx", "dy", "dz"};
  if (type == "transform.coordinate") return {"__recomputeAll"};
  if (type == "detail.fillet") return {"radius"};
  if (type == "detail.chamfer") return {"distance"};
  if (type == "detail.shell" || type == "detail.thicken") return {"thickness"};
  if (type == "detail.revolve") return {"angleDegrees", "originX", "originY", "originZ", "axisX", "axisY", "axisZ"};
  if (type == "detail.sweep" || type == "detail.pipe") return {"pathX", "pathY", "pathZ", "dx", "dy", "dz"};
  if (type == "detail.loft") return {"sectionSpacing"};
  if (type == "detail.offset") return {"distance"};
  if (type == "detail.draft") return {"angleDegrees", "neutralOriginX", "neutralOriginY", "neutralOriginZ", "neutralNormalX", "neutralNormalY", "neutralNormalZ", "directionX", "directionY", "directionZ"};
  if (type == "pattern.linear") return {"count", "spacing", "directionX", "directionY", "directionZ"};
  if (type == "pattern.circular") return {"count", "angleDegrees", "originX", "originY", "originZ", "axisX", "axisY", "axisZ"};
  if (type == "pattern.rectangular") return {"countX", "countY", "spacingX", "spacingY", "directionX", "directionY", "directionZ", "direction2X", "direction2Y", "direction2Z"};
  if (type == "pattern.mirror") return {"originX", "originY", "originZ", "normalX", "normalY", "normalZ"};
  return {};
}

using LoftSectionKey = std::pair<std::string,std::string>;
JsonValue loftSections(const FeatureNode& feature)
{
  if(feature.Type!="detail.loft" || !IsProfileLoft(feature))
    throw CadError("INVALID_SELECTION_REPAIR","Select a real-profile Loft section, not a legacy approximation.");
  return occweb::JsonParser(feature.StringParameters.at("loftSections")).Parse();
}
void storeLoftSections(FeatureNode& feature,const JsonValue& sections)
{
  feature.StringParameters["loftSections"]=JsonSerialize(sections);
  feature.InputFeatures.clear();
  for(const auto& section:sections.AsArray()){
    const auto source=section.GetString("featureId");
    if(std::find(feature.InputFeatures.begin(),feature.InputFeatures.end(),source)==feature.InputFeatures.end())feature.InputFeatures.push_back(source);
  }
}
CadError loftSectionFailure(const std::string& featureId,const std::string& sectionId,const std::string& reason)
{
  auto details=JsonValue::MakeObject();details.ChangeObject()["featureId"]=JsonValue(featureId);
  details.ChangeObject()["sectionId"]=JsonValue(sectionId);details.ChangeObject()["selectionKind"]=JsonValue(std::string("face"));
  return CadError("LOFT_SECTION_UNRESOLVED",reason,JsonSerialize(details));
}
}

namespace occweb
{
std::string CadDocument::UpdateFeature(const std::string& requestId, const int expectedRevision,
                                       const std::string& featureId, const JsonValue& parameters)
{
  return replayFeatureEdit(requestId, expectedRevision, featureId, parameters, {});
}

std::string CadDocument::PreviewFeatureInput(const std::string& requestId, const int expectedRevision,
  const std::string& targetFeatureId, const std::string& editedFeatureId, const JsonValue& parameters)
{
  JsonValue inputs=JsonValue::MakeObject();
  inputs.ChangeObject()["featureId"]=JsonValue(targetFeatureId);
  inputs.ChangeObject()["editedFeatureId"]=JsonValue(editedFeatureId);
  return PreviewFeatureInput(requestId,expectedRevision,inputs,parameters);
}

std::string CadDocument::PreviewFeatureInput(const std::string& requestId, const int expectedRevision,
  const JsonValue& inputs, const JsonValue& parameters)
{
  HistoricalInputTarget target;
  target.FeatureId=inputs.GetStringOr("featureId","");
  target.CoordinateId=inputs.GetStringOr("coordinateSystemId","");
  target.SectionId=inputs.GetStringOr("sectionId","");
  target.SweepInputId=inputs.GetStringOr("sweepInputId","");
  target.ExplicitSource=inputs.Has("sourceFeatureId") || inputs.Has("sourceBodyId");
  if(!target.SweepInputId.empty() && (!target.CoordinateId.empty() || !target.SectionId.empty()))throw CadError("FEATURE_INPUT_UNSUPPORTED","A curved sweep input cannot identify another reference family.");
  if (target.FeatureId.empty()==target.CoordinateId.empty())
    throw CadError("FEATURE_INPUT_UNSUPPORTED","Identify exactly one feature input or face coordinate source.");
  if (!target.CoordinateId.empty())
  {
    if(!target.SectionId.empty())throw CadError("FEATURE_INPUT_UNSUPPORTED","A coordinate source cannot identify a Loft section.");
    const auto coordinate=myCoordinateSystems.Records().find(target.CoordinateId);
    if(coordinate==myCoordinateSystems.Records().end() || coordinate->second.AssociationMode!="associative")
      throw CadError("INVALID_COORDINATE_REFERENCE","Select an associative face coordinate to repair.");
    target.SourceFeatureId=inputs.GetStringOr("sourceFeatureId",coordinate->second.ReferenceFeatureId);
    target.SourceBodyId=inputs.GetStringOr("sourceBodyId",coordinate->second.ReferenceBodyId);
  }
  else if(!target.SectionId.empty())
  {
    const auto feature=std::find_if(myFeatures.begin(),myFeatures.end(),[&](const auto& item){return item.Id==target.FeatureId;});
    if(feature==myFeatures.end())throw CadError("FEATURE_NOT_FOUND","Loft inspection target does not exist.");
    bool found=false;
    const auto sections=loftSections(*feature);
    for(const auto& section:sections.AsArray())if(section.GetString("sectionId")==target.SectionId){
      target.SourceFeatureId=inputs.GetStringOr("sourceFeatureId",section.GetString("featureId"));
      target.SourceBodyId=inputs.GetStringOr("sourceBodyId",section.GetString("bodyId"));found=true;break;
    }
    if(!found)throw CadError("INVALID_SELECTION_REPAIR","The Loft section no longer exists.");
  }
  else if(!target.SweepInputId.empty()){
    const auto feature=std::find_if(myFeatures.begin(),myFeatures.end(),[&](const auto& item){return item.Id==target.FeatureId;});
    if(feature==myFeatures.end())throw CadError("FEATURE_NOT_FOUND","Curved sweep inspection target does not exist.");
    const auto slots=CurveSweepInputs(*feature);const auto slot=std::find_if(slots.begin(),slots.end(),[&](const auto& item){return item.Id==target.SweepInputId;});
    if(slot==slots.end())throw CadError("INVALID_SELECTION_REPAIR","The curved sweep input no longer exists.");
    const auto reference=JsonParser(feature->StringParameters.at(slot->Field)).Parse();
    target.SourceFeatureId=inputs.GetStringOr("sourceFeatureId",reference.GetString("featureId"));target.SourceBodyId=inputs.GetStringOr("sourceBodyId",reference.GetString("bodyId"));
  }
  const auto editedFeatureId=inputs.GetStringOr("editedFeatureId",target.FeatureId);
  // Replay uses fresh constructed/imported shapes, never myBodies' live BReps.
  // Patterns can provision IDs while defining a proposed edit. Preserve those
  // counters and registrations too, including all exception paths.
  const int nextBody = myNextBody, nextFeature = myNextFeature;
  const auto identities = myEntityIdentities;
  const auto variables = myVariables;
  const auto materials = myMaterials;
  const auto coordinates = myCoordinateSystems;
  const auto features = myFeatures;
  const auto restore = [&]() {
    myNextBody = nextBody; myNextFeature = nextFeature; myEntityIdentities = identities;
    myVariables = variables; myMaterials = materials; myCoordinateSystems = coordinates; myFeatures = features;
  };
  try
  {
    std::string result;
    std::string proposedOperation = "feature.update";
    if (const auto* proposal = parameters.Find("proposal"))
    {
      if (!proposal->IsObject()) throw CadError("INVALID_INPUT_PROPOSAL", "Historical input proposal must be an object.");
      proposedOperation = proposal->GetString("operation");
      const auto* proposedParameters = proposal->Find("parameters");
      const JsonValue changes = proposedParameters ? *proposedParameters : JsonValue::MakeObject();
      const auto* inputs = proposal->Find("inputs");
      if (!changes.IsObject()) throw CadError("INVALID_INPUT_PROPOSAL", "Proposed parameters must be an object.");
      std::string proposedFeatureId;
      if (proposedOperation == "feature.update" || proposedOperation == "feature.suppress" || proposedOperation == "feature.restore" || proposedOperation == "feature.delete")
      {
        if (!inputs || !inputs->IsObject() || !inputs->Has("featureId") || !inputs->At("featureId").IsString() || inputs->GetString("featureId").empty())
          throw CadError("INVALID_INPUT_PROPOSAL", "A proposed feature operation must identify its edited feature explicitly.");
        proposedFeatureId = inputs->GetString("featureId");
      }
      if (proposedOperation == "feature.update")
        result = replayFeatureEdit(requestId, expectedRevision, proposedFeatureId, changes, target);
      else if (proposedOperation == "variable.set") result = SetVariable(requestId, expectedRevision, changes, target);
      else if (proposedOperation == "coordinate.set") result = SetCoordinateSystem(requestId, expectedRevision, changes, target);
      else if (proposedOperation == "feature.suppress" || proposedOperation == "feature.restore" || proposedOperation == "feature.delete")
        result = ChangeFeatureLifecycle(requestId, expectedRevision, proposedFeatureId, proposedOperation, changes, target);
      else throw CadError("INPUT_PROPOSAL_UNSUPPORTED", "This operation cannot be staged for historical input inspection.");
    }
    else
    {
      const auto* changes = parameters.Find("changes");
      result = replayFeatureEdit(requestId, expectedRevision, editedFeatureId,
        changes ? *changes : JsonValue::MakeObject(), target);
    }
    restore();
    result.pop_back(); result += ",\"proposalOperation\":\"" + JsonEscape(proposedOperation) + "\"}";
    return result;
  }
  catch (...)
  {
    restore();
    throw;
  }
}

struct CadDocument::ImportedNamingUpgrade
{
  bool Upgrading = false;
  std::map<std::pair<std::string,std::string>,std::string> Outputs;
  struct Selection { std::string Fingerprint, Kind; int Index; };
  std::map<std::string,Selection> Selections;
  std::set<std::string> ReboundSelections;
  std::set<std::pair<std::string,std::string>> VerifiedOutputs;
  std::map<std::string,TopologyNames> Names;
  std::vector<FeatureNode> Features;
  CoordinateSystemStore Coordinates;
  std::string ArchiveTarget;
  std::map<std::string,NamedTopologyBody> ArchiveOutputs;
  FeatureNode ArchiveDefinition;
  bool ArchiveReached=false;

  void rebind(const std::string& key, const TopoDS_Shape& shape,
              const TopologyNames& names, const std::string& kind, std::string& selector)
  {
    const auto fingerprint=ShapeFingerprint(shape);
    if (!Upgrading)
    {
      if (Selections.size()>=10000) throw CadError("IMPORT_NAMING_UPGRADE_LIMIT","Upgrade exceeds 10000 historical selections.");
      const auto stored=JsonParser(selector).Parse();
      if(stored.GetString("kind")!=kind)throw CadError("INVALID_SELECTION_REFERENCE","Historical selection kind does not match its owner.");
      const int index=TopologyNaming::ResolveSelection(shape,names,selector);
      if(!Selections.emplace(key,Selection{fingerprint,kind,index}).second)
        throw CadError("INVALID_FEATURE_GRAPH","Duplicate historical selection ownership during naming upgrade.");
      return;
    }
    const auto original=Selections.find(key);
    if(original==Selections.end() || original->second.Fingerprint!=fingerprint || original->second.Kind!=kind)
      throw CadError("IMPORT_NAMING_UPGRADE_GEOMETRY_CHANGED","Historical input differs from the verified unchanged replay; no index fallback was used.");
    selector=TopologyNaming::CaptureSelection(shape,names,kind,original->second.Index);
    if(!ReboundSelections.insert(key).second)throw CadError("INVALID_FEATURE_GRAPH","Historical selection was rebound more than once.");
  }

  void observe(const FeatureNode& feature,const std::string& bodyId,const TopoDS_Shape& shape)
  {
    const auto key=std::make_pair(feature.Id,bodyId);
    const auto fingerprint=ShapeFingerprint(shape);
    if(!Upgrading)
    {
      if(Outputs.size()>=10000)throw CadError("IMPORT_NAMING_UPGRADE_LIMIT","Upgrade exceeds 10000 historical outputs.");
      if(!Outputs.emplace(key,fingerprint).second)throw CadError("INVALID_FEATURE_GRAPH","Duplicate historical output during naming upgrade.");
    }
    else
    {
      const auto old=Outputs.find(key);
      if(old==Outputs.end() || old->second!=fingerprint)
        throw CadError("IMPORT_NAMING_UPGRADE_GEOMETRY_CHANGED","Naming upgrade changed a historical output; no changes were committed.");
      if(!VerifiedOutputs.insert(key).second)throw CadError("INVALID_FEATURE_GRAPH","Historical output was verified more than once.");
    }
  }
};

std::string CadDocument::UpgradeImportedNaming(const std::string& requestId,const int expectedRevision,const bool preview)
{
  if(expectedRevision!=myRevision)throw CadError("STALE_REVISION","Reload the project before upgrading imported references.");
  std::size_t sources=0;
  for(const auto& feature:myFeatures)
  {
    if(feature.Type!="import.step")continue;
    const auto version=feature.NumberParameters.find("importNamingVersion");
    if(version!=feature.NumberParameters.end())
    {
      if(version->second!=1.0)throw CadError("STEP_NAMING_VERSION_UNSUPPORTED","Unsupported imported topology naming version.");
      continue;
    }
    if(number(feature,"decompositionVersion")!=2.0 || textParameter(feature,"sourceFingerprintAlgorithm")!="sha256-chain-1m-v1")
      throw CadError("IMPORT_NAMING_UPGRADE_SOURCE_UNVERIFIED","This legacy import has no verified versioned STEP source. Restore or reimport its source before upgrading.");
    ++sources;
  }
  ImportedNamingUpgrade migration;
  std::size_t archivedProofCount=0,archivedReferenceCount=0,archivedSourceCount=0;
  if(sources)
  {
    const int nextBody=myNextBody,nextFeature=myNextFeature;
    const auto identities=myEntityIdentities;
    const auto restoreCounters=[&](){myNextBody=nextBody;myNextFeature=nextFeature;myEntityIdentities=identities;};
    auto parameters=JsonParser("{\"__lifecycleReplay\":true}").Parse();
    try
    {
      replayFeatureEdit(requestId,expectedRevision,myFeatures.front().Id,parameters,{},&migration);
      restoreCounters();
      migration.Upgrading=true;
      replayFeatureEdit(requestId,expectedRevision,myFeatures.front().Id,parameters,{},&migration);
      using ArchiveSlot=std::pair<std::string,std::string>;
      std::map<std::string,std::vector<ArchiveSlot>> archivedSources;
      for(const auto& owner:myFeatures)for(const auto& [bodyId,proof]:owner.SuspendedTopology){
        if(++archivedProofCount>256)throw CadError("IMPORT_NAMING_UPGRADE_ARCHIVE_LIMIT","Upgrade exceeds 256 archived output proofs.");
        const auto identity=InspectSuspendedTopology(proof);
        if(identity.BodyId!=bodyId || std::find(owner.OutputBodies.begin(),owner.OutputBodies.end(),bodyId)==owner.OutputBodies.end())
          throw CadError("IMPORT_NAMING_UPGRADE_ARCHIVE_UNVERIFIED","Archived output is no longer owned by its recorded feature.");
        archivedSources[identity.SourceFeatureId].push_back({owner.Id,bodyId});
      }
      // A suppressed output can also own dormant Face coordinates without a
      // removed-Body recovery record (e.g. a suppressed unary feature).
      for(const auto& [id,coordinate]:myCoordinateSystems.Records())if(coordinate.AssociationMode=="associative" && coordinate.ReferenceState!="resolved"){
        const auto source=std::find_if(myFeatures.begin(),myFeatures.end(),[&](const auto& feature){return feature.Id==coordinate.ReferenceFeatureId;});
        if(source!=myFeatures.end() && source->State=="suppressed")archivedSources.try_emplace(source->Id);
      }
      if(archivedSources.size()>64)throw CadError("IMPORT_NAMING_UPGRADE_ARCHIVE_LIMIT","Upgrade exceeds 64 independently replayed archive sources.");
      archivedSourceCount=archivedSources.size();
      std::size_t retainedBytes=0;
      for(const auto& [sourceId,slots]:archivedSources){
        const auto source=std::find_if(myFeatures.begin(),myFeatures.end(),[&](const auto& feature){return feature.Id==sourceId;});
        if(source==myFeatures.end() || source->Identity.empty())throw CadError("IMPORT_NAMING_UPGRADE_ARCHIVE_UNVERIFIED","Archived source feature is missing or lacks persistent ownership.");
        ImportedNamingUpgrade archived;archived.ArchiveTarget=sourceId;
        try{
          restoreCounters();replayFeatureEdit(requestId,expectedRevision,myFeatures.front().Id,parameters,{},&archived);
          if(!archived.ArchiveReached)throw CadError("IMPORT_NAMING_UPGRADE_ARCHIVE_UNVERIFIED","Archived source output was not reached.");
          const auto oldOutputs=archived.ArchiveOutputs;
          archived.ArchiveOutputs.clear();archived.ArchiveReached=false;archived.Upgrading=true;
          restoreCounters();replayFeatureEdit(requestId,expectedRevision,myFeatures.front().Id,parameters,{},&archived);
          if(!archived.ArchiveReached)throw CadError("IMPORT_NAMING_UPGRADE_ARCHIVE_UNVERIFIED","Upgraded archived source output was not reached.");
          if(myNextBody!=nextBody || myNextFeature!=nextFeature || myEntityIdentities.size()!=identities.size())throw CadError("IMPORT_NAMING_UPGRADE_ARCHIVE_UNVERIFIED","Restoring the archive would allocate replacement entities.");
          archivedReferenceCount+=archived.Selections.size();
          if(archivedReferenceCount>640000)throw CadError("IMPORT_NAMING_UPGRADE_ARCHIVE_LIMIT","Upgrade exceeds 640000 archived selection checks.");
          for(const auto& [ownerId,bodyId]:slots){
            const auto identity=identities.find(bodyId);
            const auto before=oldOutputs.find(bodyId);
            const auto after=archived.ArchiveOutputs.find(bodyId);
            if(identity==identities.end() || before==oldOutputs.end() || after==archived.ArchiveOutputs.end())throw CadError("IMPORT_NAMING_UPGRADE_ARCHIVE_UNVERIFIED","Archived Body is not an exact output of its recorded source feature.");
            const auto owner=std::find_if(myFeatures.begin(),myFeatures.end(),[&](const auto& feature){return feature.Id==ownerId;});
            const auto stagedOwner=std::find_if(migration.Features.begin(),migration.Features.end(),[&](const auto& feature){return feature.Id==ownerId;});
            if(owner==myFeatures.end() || stagedOwner==migration.Features.end())throw CadError("IMPORT_NAMING_UPGRADE_ARCHIVE_UNVERIFIED","Archived proof owner was not retained.");
            auto updated=RecertifySuspendedTopology(owner->SuspendedTopology.at(bodyId),before->second.Shape,before->second.Names,
              after->second.Shape,after->second.Names,*source,archived.ArchiveDefinition,bodyId,identity->second.Body,myRevision);
            retainedBytes+=updated.size();if(retainedBytes>64u*1024u*1024u)throw CadError("IMPORT_NAMING_UPGRADE_ARCHIVE_LIMIT","Retained archived migration evidence exceeds 64 MiB.");
            stagedOwner->SuspendedTopology[bodyId]=std::move(updated);
          }
          for(const auto& staged:archived.Features){
            const auto destination=std::find_if(migration.Features.begin(),migration.Features.end(),[&](const auto& feature){return feature.Id==staged.Id;});
            if(destination==migration.Features.end())throw CadError("IMPORT_NAMING_UPGRADE_ARCHIVE_UNVERIFIED","Historical feature ownership changed during archive replay.");
            for(const auto& [key,value]:staged.StringParameters)if(key.rfind("selection.",0)==0 || key=="loftSections" || key=="sweepProfile" || key=="sweepPath")destination->StringParameters[key]=value;
          }
          for(const auto& [id,coordinate]:archived.Coordinates.Records())if(coordinate.AssociationMode=="associative" && coordinate.ReferenceFeatureId==sourceId){
            auto current=migration.Coordinates.Records().at(id);
            if(current.ReferenceFeatureIdentity!=coordinate.ReferenceFeatureIdentity || current.ReferenceBodyIdentity!=coordinate.ReferenceBodyIdentity || current.ReferenceBodyId!=coordinate.ReferenceBodyId)
              throw CadError("IMPORT_NAMING_UPGRADE_ARCHIVE_UNVERIFIED","Dormant coordinate ownership changed during archive replay.");
            current.ReferenceSelector=coordinate.ReferenceSelector;migration.Coordinates.Set(current);
          }
        }catch(const CadError& error){
          throw CadError(error.Code(),error.what(),"{\"archiveSourceFeatureId\":\""+JsonEscape(sourceId)+"\",\"archiveProofCount\":"+std::to_string(slots.size())+"}");
        }
      }
      if(myNextBody!=nextBody || myNextFeature!=nextFeature || myEntityIdentities.size()!=identities.size())
        throw CadError("IMPORT_NAMING_UPGRADE_GEOMETRY_CHANGED","Replay would allocate new entities; naming-only migration was not committed.");
      restoreCounters();
    }
    catch(...){restoreCounters();throw;}
  }
  auto report=JsonValue::MakeObject();auto& fields=report.ChangeObject();
  fields["version"]=JsonValue(1.0);fields["preview"]=JsonValue(preview);
  fields["sourceCount"]=JsonValue(double(sources));fields["bodyCount"]=JsonValue(double(myBodies.size()));
  fields["historicalOutputCount"]=JsonValue(double(migration.Outputs.size()));fields["referenceCount"]=JsonValue(double(migration.Selections.size()));
  fields["archivedProofCount"]=JsonValue(double(archivedProofCount));fields["archivedReferenceCount"]=JsonValue(double(archivedReferenceCount));
  fields["archivedSourceCount"]=JsonValue(double(archivedSourceCount));
  fields["geometryUnchanged"]=JsonValue(true);fields["topologyIdentitiesUnchanged"]=JsonValue(true);
  fields["changed"]=JsonValue(!preview && sources>0);
  if(!preview && sources)
  {
    // Keep actual Shapes, topology revisions/UUIDs and property targets. Only
    // the independently verified naming metadata and selectors are replaced.
    myFeatures=std::move(migration.Features);
    myCoordinateSystems=std::move(migration.Coordinates);
    for(auto& [id,body]:myBodies)body.Names=std::move(migration.Names.at(id));
    ++myRevision;
    persistMetadata();
  }
  return responsePrefix(requestId)+",\"importedNamingUpgrade\":"+JsonSerialize(report)+"}";
}

std::string CadDocument::replayFeatureEdit(const std::string& requestId, const int expectedRevision,
  const std::string& featureId, const JsonValue& inputParameters, const HistoricalInputTarget& requestedInspectionTarget,
  ImportedNamingUpgrade* namingUpgrade)
{
  auto inspectionTarget=requestedInspectionTarget;
  if (expectedRevision != myRevision)
    throw CadError("STALE_REVISION", "Document revision is stale. Reload before editing the feature.");
  const auto editedIterator = std::find_if(myFeatures.begin(), myFeatures.end(),
    [&](const FeatureNode& feature) { return feature.Id == featureId; });
  if (editedIterator == myFeatures.end()) throw CadError("FEATURE_NOT_FOUND", "Feature does not exist.");
  const std::size_t editedIndex = static_cast<std::size_t>(std::distance(myFeatures.begin(), editedIterator));
  JsonValue parameters = inputParameters;
  if (!parameters.IsObject()) throw CadError("INVALID_PARAMETER", "Feature changes must be an object.");
  std::map<std::string, JsonValue> selectionEdits;
  std::map<LoftSectionKey, JsonValue> loftEdits;
  std::map<LoftSectionKey, JsonValue> sweepEdits;
  std::map<std::string, JsonValue> coordinateEdits;
  if (const auto* edits=parameters.Find("coordinateSelectionEdits"))
  {
    if(!edits->IsArray() || edits->AsArray().size()>64)
      throw CadError("INVALID_SELECTION_REPAIR","coordinateSelectionEdits must contain at most 64 explicit selections.");
    for(const auto& edit:edits->AsArray())
      if(!coordinateEdits.emplace(edit.GetString("coordinateSystemId"),edit).second)
        throw CadError("INVALID_SELECTION_REPAIR","Duplicate coordinate selection repair.");
    parameters.ChangeObject().erase("coordinateSelectionEdits");
  }
  if (const auto* edits = parameters.Find("selectionEdits"))
  {
    if (!edits->IsArray() || edits->AsArray().size() > 64) throw CadError("INVALID_SELECTION_REPAIR", "selectionEdits must contain at most 64 explicit selections.");
    for (const auto& edit : edits->AsArray())
    {
      if(edit.Has("holeIndexes")&&!edit.Has("sectionId"))throw CadError("INVALID_SELECTION_REPAIR","Hole loop selections belong only to an explicit Loft section repair.");
      const auto id = edit.GetString("featureId");
      if(edit.Has("sweepInputId")){
        const auto slot=edit.GetString("sweepInputId");
        if(edit.Has("sectionId") || slot.empty() || !sweepEdits.emplace(LoftSectionKey{id,slot},edit).second)throw CadError("INVALID_SELECTION_REPAIR","Duplicate, mixed or empty curved sweep input repair.");
      }else if(edit.Has("sectionId")){
        const auto section=edit.GetString("sectionId");
        if(section.empty() || !loftEdits.emplace(LoftSectionKey{id,section},edit).second)throw CadError("INVALID_SELECTION_REPAIR","Duplicate or empty Loft section repair.");
      }else if (!selectionEdits.emplace(id, edit).second) throw CadError("INVALID_SELECTION_REPAIR", "Duplicate selection repair feature.");
    }
    parameters.ChangeObject().erase("selectionEdits");
  }
  const auto referenceKind = [](const FeatureNode& feature) -> std::string {
    if((feature.Type=="detail.sweep" || feature.Type=="detail.pipe") && IsCurveSweep(feature))return "";
    if (feature.Type == "detail.fillet" || feature.Type == "detail.chamfer") return "edge";
    if (feature.Type == "detail.shell" || feature.Type == "detail.thicken" || feature.Type == "detail.draft"
      || feature.Type == "detail.revolve" || feature.Type == "detail.sweep" || feature.Type == "detail.pipe") return "face";
    return "";
  };
  const auto referenceBody = [](const FeatureNode& feature) {
    const auto found = feature.StringParameters.find("sourceBody");
    return found != feature.StringParameters.end() && !found->second.empty() ? found->second : feature.OutputBodies.empty() ? std::string() : feature.OutputBodies.front();
  };
  if (!inspectionTarget.FeatureId.empty() && inspectionTarget.SectionId.empty() && inspectionTarget.SweepInputId.empty())
  {
    const auto target = std::find_if(myFeatures.begin(), myFeatures.end(), [&](const auto& feature) { return feature.Id == inspectionTarget.FeatureId; });
    if (target == myFeatures.end() || referenceKind(*target).empty()) throw CadError("FEATURE_INPUT_UNSUPPORTED", "Select a feature with a Face or Edge input.");
    if (static_cast<std::size_t>(std::distance(myFeatures.begin(), target)) < editedIndex) throw CadError("INVALID_SELECTION_REPAIR", "The inspected input must not precede the proposed edit.");
  }
  const std::set<std::string> allowed = allowedParameters(editedIterator->Type);
  const bool editingBoolean = isBooleanType(editedIterator->Type);
  const bool lifecycleReplay = parameters.GetBooleanOr("__lifecycleReplay", false);
  const bool dynamicBodyReplay = std::any_of(myFeatures.begin(), myFeatures.end(), [](const FeatureNode& feature) { return feature.Type.rfind("pattern.", 0) == 0; });
  if (allowed.empty() && !editingBoolean && !lifecycleReplay)
    throw CadError("FEATURE_NOT_EDITABLE", "Only primitive, Transform, Fillet and Boolean parameters are editable.");

  FeatureNode editedFeature = *editedIterator;
  const bool recomputeAll = parameters.GetBooleanOr("__recomputeAll", false);
  if(const auto* definition=parameters.Find("loftDefinition")){
    if(editedFeature.Type!="detail.loft" || !definition->IsObject())throw CadError("INVALID_PARAMETER","loftDefinition belongs to a Loft feature.");
    JsonValue changes=*definition,sections;
    if(const auto* supplied=changes.Find("sections")){sections=*supplied;changes.ChangeObject().erase("sections");}
    else if(IsProfileLoft(editedFeature)){
      const auto stored=JsonParser(editedFeature.StringParameters.at("loftSections")).Parse();sections=JsonValue::MakeArray();
      for(const auto& reference:stored.AsArray()){auto retained=JsonValue::MakeObject();retained.ChangeObject()["sectionId"]=reference.At("sectionId");sections.ChangeArray().push_back(retained);}
    }
    configureLoft(editedFeature,sections,changes);parameters.ChangeObject().erase("loftDefinition");
  }
  if(const auto* definition=parameters.Find("sweepDefinition")){
    if((editedFeature.Type!="detail.sweep" && editedFeature.Type!="detail.pipe") || !definition->IsObject())throw CadError("INVALID_PARAMETER","sweepDefinition belongs to a sweep or pipe feature.");
    configureCurveSweep(editedFeature,*definition);parameters.ChangeObject().erase("sweepDefinition");
  }
  if (editingBoolean)
  {
    if (!lifecycleReplay) updateBooleanDefinition(editedFeature, parameters);
  }
  else for (const auto& [key, value] : parameters.AsObject())
  {
    if (key == "__recomputeAll" || key == "__lifecycleReplay") continue;
    if(IsCurveSweep(editedFeature))throw CadError("INVALID_PARAMETER","Curved sweep edits use sweepDefinition; legacy path vectors do not control a selected model path.");
    if(editedFeature.Type=="detail.loft" && IsProfileLoft(editedFeature) && editedFeature.StringParameters.at("loftPlacement")=="actual" && key=="sectionSpacing")
      throw CadError("INVALID_PARAMETER","Actual-position Loft has no editable spacing; change the Loft definition placement explicitly.");
    if (allowed.find(key) == allowed.end())
      throw CadError("INVALID_PARAMETER", "Parameter is not editable for this feature: " + key);
    const std::string expectedType = ScalarParameterType(key);
    parameterValue(parameters, key, expectedType, 0.0, true, &editedFeature);
  }

  const auto preparePatternDefinition = [&](FeatureNode& editedFeature) {
  if (editedFeature.Type == "pattern.linear" || editedFeature.Type == "pattern.circular" || editedFeature.Type == "pattern.rectangular")
  {
    if (editedFeature.Type == "pattern.rectangular")
      for (const auto& key : {"countX", "countY"}) {
        const double value = number(editedFeature, key, 1.0);
        if (!std::isfinite(value) || value != std::round(value) || value < 1 || value > 20)
          throw CadError("INVALID_PARAMETER", "Rectangular pattern counts must be integers between 1 and 20.");
      }
    const double desiredValue = editedFeature.Type == "pattern.rectangular" ? number(editedFeature, "countX", 1.0) * number(editedFeature, "countY", 1.0) : number(editedFeature, "count", 2.0);
    if (!std::isfinite(desiredValue) || desiredValue != std::round(desiredValue) || desiredValue < 2 || desiredValue > 100)
      throw CadError("INVALID_PARAMETER", "Linear pattern count must be an integer between 2 and 100.");
    const int desiredCount = static_cast<int>(desiredValue);
    editedFeature.NumberParameters["count"] = desiredCount;
    const std::string sourceBodyId = textParameter(editedFeature, "sourceBody");
    const auto sourceBody = myBodies.find(sourceBodyId);
    // A source can be consumed by a later Boolean and absent from the final
    // body map. Existing pattern output metadata remains authoritative for
    // provisioning additional instances; actual geometry comes from replay.
    const auto storedMetadata = [&](const std::string& suffix, const std::string& fallback) {
      if (editedFeature.OutputBodies.empty()) return fallback;
      const auto value = editedFeature.StringParameters.find("outputBodyMeta." + editedFeature.OutputBodies.front() + "." + suffix);
      return value == editedFeature.StringParameters.end() ? fallback : value->second;
    };
    const bool hasLiveSource = sourceBody != myBodies.end();
    const std::string sourceName = hasLiveSource && !sourceBody->second.Name.empty() ? sourceBody->second.Name : storedMetadata("name", "Body");
    const std::string sourceColor = hasLiveSource ? sourceBody->second.Color : storedMetadata("color", "#7b91aa");
    const std::string sourceMaterial = hasLiveSource ? sourceBody->second.Material : storedMetadata("material", "");
    const std::string sourceVisible = hasLiveSource ? (sourceBody->second.Visible ? "true" : "false") : storedMetadata("visible", "true");
    const std::string sourceOpacity = hasLiveSource ? FormatBodyOpacity(sourceBody->second.Opacity) : storedMetadata("opacity", "1");
    // Preserve logical grid coordinates, not flattened enumeration positions.
    // Retired slots get fresh Body IDs if created again; Undo alone restores old identities.
    const auto original=std::find_if(myFeatures.begin(),myFeatures.end(),[&](const FeatureNode& item){return item.Id==editedFeature.Id;});
    const FeatureNode& previous=original==myFeatures.end()?editedFeature:*original;
    std::map<std::string,std::string> oldSlots;
    for(std::size_t index=0;index<previous.OutputBodies.size();++index){
      const auto& id=previous.OutputBodies[index];const auto stored=previous.StringParameters.find("patternSlot."+id);
      const auto slot=stored==previous.StringParameters.end()?occweb::PatternSlot(previous,index):stored->second;
      if(!oldSlots.emplace(slot,id).second)throw CadError("INVALID_FEATURE_GRAPH","Duplicate pattern instance slot.");
    }
    std::vector<std::string> outputs;
    for(int index=0;index<desiredCount;++index){
      const auto slot=occweb::PatternSlot(editedFeature,index);const auto existing=oldSlots.find(slot);
      const auto id=existing==oldSlots.end()?nextBodyId():existing->second;outputs.push_back(id);
      editedFeature.StringParameters["patternSlot."+id]=slot;
    }
    editedFeature.OutputBodies=std::move(outputs);
    for (std::size_t index = 0; index < editedFeature.OutputBodies.size(); ++index)
    {
      const std::string bodyId = editedFeature.OutputBodies[index];
      const std::string prefix = "outputBodyMeta." + bodyId + ".";
      if (editedFeature.StringParameters.find(prefix + "name") == editedFeature.StringParameters.end())
        editedFeature.StringParameters[prefix + "name"] = sourceName + (editedFeature.Type == "pattern.mirror" ? " Mirror Pattern " : editedFeature.Type == "pattern.circular" ? " Circular Pattern " : editedFeature.Type == "pattern.rectangular" ? " Rectangular Pattern " : " Linear Pattern ") + std::to_string(index + 1);
      if (editedFeature.StringParameters.find(prefix + "color") == editedFeature.StringParameters.end())
        editedFeature.StringParameters[prefix + "color"] = sourceColor;
      if (editedFeature.StringParameters.find(prefix + "material") == editedFeature.StringParameters.end())
        editedFeature.StringParameters[prefix + "material"] = sourceMaterial;
      if (editedFeature.StringParameters.find(prefix + "visible") == editedFeature.StringParameters.end())
        editedFeature.StringParameters[prefix + "visible"] = sourceVisible;
      if (editedFeature.StringParameters.find(prefix + "opacity") == editedFeature.StringParameters.end())
        editedFeature.StringParameters[prefix + "opacity"] = sourceOpacity;
    }
  }
  };
  std::vector<FeatureNode> replayDefinitions = myFeatures;
  replayDefinitions[editedIndex] = editedFeature;
  CoordinateSystemStore replayCoordinates=myCoordinateSystems;
  if(namingUpgrade && !namingUpgrade->ArchiveTarget.empty()){
    const auto target=std::find_if(replayDefinitions.begin(),replayDefinitions.end(),[&](const auto& feature){return feature.Id==namingUpgrade->ArchiveTarget;});
    if(target==replayDefinitions.end())throw CadError("IMPORT_NAMING_UPGRADE_ARCHIVE_UNVERIFIED","Archived replay source no longer exists.");
    target->State="valid";
    const auto closure=CoordinateReplayOrder(replayDefinitions,replayCoordinates,target->Id);std::set<std::string> included;
    for(const auto index:closure)included.insert(replayDefinitions[index].Id);
    replayDefinitions.erase(std::remove_if(replayDefinitions.begin(),replayDefinitions.end(),[&](const auto& feature){return !included.count(feature.Id);}),replayDefinitions.end());
  }
  const auto findSweepSlot=[](const FeatureNode& feature,const std::string& inputId){
    const auto slots=CurveSweepInputs(feature);const auto found=std::find_if(slots.begin(),slots.end(),[&](const auto& item){return item.Id==inputId;});
    if(found==slots.end())throw CadError("INVALID_SELECTION_REPAIR","The curved sweep repair input no longer exists.");return *found;
  };
  std::map<LoftSectionKey,std::pair<std::string,std::string>> sweepRoleSources;
  const auto prepareSweepSource=[&](const LoftSectionKey& key,const std::string& sourceId,const std::string& bodyId){
    auto target=std::find_if(replayDefinitions.begin(),replayDefinitions.end(),[&](const auto& item){return item.Id==key.first;});
    if(target==replayDefinitions.end())throw CadError("INVALID_SELECTION_REPAIR","Curved sweep repair target does not exist.");
    const auto slot=findSweepSlot(*target,key.second);const auto role=LoftSectionKey{key.first,slot.Field};
    const auto [previous,inserted]=sweepRoleSources.emplace(role,std::make_pair(sourceId,bodyId));
    if(!inserted && previous->second!=std::make_pair(sourceId,bodyId))throw CadError("INVALID_SELECTION_REPAIR","All repaired path edges must use the same historical source Body.");
    auto source=std::find_if(replayDefinitions.begin(),replayDefinitions.end(),[&](const auto& item){return item.Id==sourceId;});const auto identity=myEntityIdentities.find(bodyId);
    if(sourceId==key.first)throw CadError("SWEEP_DEPENDENCY_CYCLE","A curved sweep cannot use its own output as an input.");
    if(source==replayDefinitions.end() || source->State=="suppressed" || identity==myEntityIdentities.end() || std::find(source->OutputBodies.begin(),source->OutputBodies.end(),bodyId)==source->OutputBodies.end())
      throw CurveSweepInputFailure(key.first,key.second,slot.Kind,"The proposed historical sweep source is unavailable. Select another real source output.");
    if(source->Identity.empty())source->Identity=newIdentity();auto reference=JsonParser(target->StringParameters.at(slot.Field)).Parse();auto& fields=reference.ChangeObject();
    fields["bodyId"]=JsonValue(bodyId);fields["bodyIdentity"]=JsonValue(identity->second.Body);fields["featureId"]=JsonValue(sourceId);fields["featureIdentity"]=JsonValue(source->Identity);
    StoreCurveSweepReference(*target,slot.Field,reference);
  };
  for(const auto& [key,edit]:sweepEdits)prepareSweepSource(key,edit.GetString("sourceFeatureId"),edit.GetString("sourceBodyId"));
  if(!inspectionTarget.SweepInputId.empty()){
    const auto target=std::find_if(replayDefinitions.begin(),replayDefinitions.end(),[&](const auto& item){return item.Id==inspectionTarget.FeatureId;});
    if(target==replayDefinitions.end())throw CadError("INVALID_SELECTION_REPAIR","Curved sweep inspection target does not exist.");
    const auto slot=findSweepSlot(*target,inspectionTarget.SweepInputId);
    if(!inspectionTarget.ExplicitSource){const auto reference=JsonParser(target->StringParameters.at(slot.Field)).Parse();inspectionTarget.SourceFeatureId=reference.GetString("featureId");inspectionTarget.SourceBodyId=reference.GetString("bodyId");}
    prepareSweepSource({inspectionTarget.FeatureId,inspectionTarget.SweepInputId},inspectionTarget.SourceFeatureId,inspectionTarget.SourceBodyId);
  }
  if(inspectionTarget.empty())for(const auto& feature:replayDefinitions)if(feature.State!="suppressed" && (feature.Type=="detail.sweep" || feature.Type=="detail.pipe") && IsCurveSweep(feature)){
    for(const auto& slot:CurveSweepInputs(feature)){
      const auto reference=JsonParser(feature.StringParameters.at(slot.Field)).Parse();const auto source=std::find_if(replayDefinitions.begin(),replayDefinitions.end(),[&](const auto& item){return item.Id==reference.GetString("featureId");});const auto identity=myEntityIdentities.find(reference.GetString("bodyId"));
      if(source==replayDefinitions.end() || source->State=="suppressed" || source->Identity!=reference.GetString("featureIdentity") || identity==myEntityIdentities.end() || identity->second.Body!=reference.GetString("bodyIdentity") || std::find(source->OutputBodies.begin(),source->OutputBodies.end(),reference.GetString("bodyId"))==source->OutputBodies.end())
        throw CurveSweepInputFailure(feature.Id,slot.Id,slot.Kind,"The historical sweep source was deleted, suppressed or replaced. Reselect the intended historical input.");
    }
  }
  // Source ownership is staged first so dependency ordering and cycle checks
  // use the proposed graph. Face proof is checked only at the exact output.
  const auto prepareLoftSource=[&](const LoftSectionKey& key,const std::string& sourceId,const std::string& bodyId)
  {
    auto target=std::find_if(replayDefinitions.begin(),replayDefinitions.end(),[&](const auto& item){return item.Id==key.first;});
    if(target==replayDefinitions.end())throw CadError("INVALID_SELECTION_REPAIR","Loft repair target does not exist.");
    auto sections=loftSections(*target);auto section=std::find_if(sections.ChangeArray().begin(),sections.ChangeArray().end(),[&](const auto& item){return item.GetString("sectionId")==key.second;});
    if(section==sections.ChangeArray().end())throw CadError("INVALID_SELECTION_REPAIR","Loft section repair target does not exist.");
    auto source=std::find_if(replayDefinitions.begin(),replayDefinitions.end(),[&](const auto& item){return item.Id==sourceId;});
    const auto identity=myEntityIdentities.find(bodyId);
    if(sourceId==key.first)throw CadError("LOFT_DEPENDENCY_CYCLE","A Loft cannot use its own output as a section.");
    if(source==replayDefinitions.end() || source->State=="suppressed" || identity==myEntityIdentities.end()
      || std::find(source->OutputBodies.begin(),source->OutputBodies.end(),bodyId)==source->OutputBodies.end())
      throw loftSectionFailure(key.first,key.second,"The proposed historical section source is unavailable. Select another real source output.");
    if(source->Identity.empty())source->Identity=newIdentity();
    section->ChangeObject()["bodyId"]=JsonValue(bodyId);section->ChangeObject()["bodyIdentity"]=JsonValue(identity->second.Body);
    section->ChangeObject()["featureId"]=JsonValue(sourceId);section->ChangeObject()["featureIdentity"]=JsonValue(source->Identity);
    storeLoftSections(*target,sections);
  };
  for(const auto& [key,edit]:loftEdits)prepareLoftSource(key,edit.GetString("sourceFeatureId"),edit.GetString("sourceBodyId"));
  if(!inspectionTarget.SectionId.empty())prepareLoftSource({inspectionTarget.FeatureId,inspectionTarget.SectionId},inspectionTarget.SourceFeatureId,inspectionTarget.SourceBodyId);
  if(inspectionTarget.empty())for(const auto& feature:replayDefinitions)if(feature.State!="suppressed" && feature.Type=="detail.loft" && IsProfileLoft(feature)){
    const auto sections=loftSections(feature);
    for(const auto& section:sections.AsArray()){
      const auto source=std::find_if(replayDefinitions.begin(),replayDefinitions.end(),[&](const auto& item){return item.Id==section.GetString("featureId");});
      const auto identity=myEntityIdentities.find(section.GetString("bodyId"));
      if(source==replayDefinitions.end() || source->State=="suppressed" || source->Identity!=section.GetString("featureIdentity")
        || identity==myEntityIdentities.end() || identity->second.Body!=section.GetString("bodyIdentity")
        || std::find(source->OutputBodies.begin(),source->OutputBodies.end(),section.GetString("bodyId"))==source->OutputBodies.end())
        throw loftSectionFailure(feature.Id,section.GetString("sectionId"),"Loft section source was deleted, suppressed or replaced. Reselect its historical source; final live geometry is not a substitute.");
    }
  }
  // Establish only dependency ownership here. Face evidence is checked against
  // the actual newly replayed historical BRep before any dependent geometry.
  const auto prepareCoordinateSource=[&](const std::string& coordinateId,const std::string& sourceId,const std::string& bodyId)
  {
    const auto found=replayCoordinates.Records().find(coordinateId);
    if(found==replayCoordinates.Records().end() || found->second.AssociationMode!="associative")
      throw CadError("INVALID_COORDINATE_REFERENCE","仅可修复已有的关联面坐标系。");
    auto source=std::find_if(replayDefinitions.begin(),replayDefinitions.end(),[&](const auto& item){return item.Id==sourceId;});
    const auto identity=myEntityIdentities.find(bodyId);
    if(source==replayDefinitions.end() || source->State=="suppressed" || identity==myEntityIdentities.end()
        || std::find(source->OutputBodies.begin(),source->OutputBodies.end(),bodyId)==source->OutputBodies.end())
      throw CadError("FEATURE_INPUT_UNAVAILABLE","所选历史来源在本次修改后不可用，请选择仍有效的特征及输出 Body。");
    auto record=found->second;
    if(source->Identity.empty())source->Identity=newIdentity();
    record.ReferenceBodyId=bodyId;record.ReferenceBodyIdentity=identity->second.Body;
    record.ReferenceFeatureId=sourceId;record.ReferenceFeatureIdentity=source->Identity;
    replayCoordinates.Set(record);
  };
  for(const auto& [id,edit]:coordinateEdits)
    prepareCoordinateSource(id,edit.GetString("sourceFeatureId"),edit.GetString("sourceBodyId"));
  if(!inspectionTarget.CoordinateId.empty())
    prepareCoordinateSource(inspectionTarget.CoordinateId,inspectionTarget.SourceFeatureId,inspectionTarget.SourceBodyId);
  const auto coordinateRecords=replayCoordinates.Records();
  for (auto [id,record]:coordinateRecords)
    if (record.AssociationMode=="associative")
    {
      record.ReferenceState="unresolved";record.ResolvedFaceIndex=0;
      record.ReferenceDiagnostic="来源历史输出尚未解析，未使用旧快照。";
      replayCoordinates.Set(record);
    }
  const auto replayOrder=CoordinateReplayOrder(replayDefinitions,replayCoordinates,
    inspectionTarget.CoordinateId.empty() && inspectionTarget.SectionId.empty() && inspectionTarget.SweepInputId.empty()?inspectionTarget.FeatureId:inspectionTarget.SourceFeatureId);
  std::map<std::string, ReplayBody> replayBodies;
  std::set<std::pair<std::string,std::string>> loftSources;
  std::set<std::pair<std::string,std::string>> sweepSources;
  for(const auto& definition:replayDefinitions)if((definition.Type=="detail.sweep" || definition.Type=="detail.pipe") && IsCurveSweep(definition))
    for(const auto& field:{"sweepProfile","sweepPath"}){const auto reference=JsonParser(definition.StringParameters.at(field)).Parse();sweepSources.emplace(reference.GetString("featureId"),reference.GetString("bodyId"));}
  std::map<std::pair<std::string,std::string>,ReplayBody> sweepOutputs;
  std::map<std::pair<std::string,std::string>,std::set<std::size_t>> sweepConsumers;
  for(std::size_t index=0;index<replayDefinitions.size();++index){const auto& feature=replayDefinitions[index];if((feature.Type=="detail.sweep" || feature.Type=="detail.pipe") && IsCurveSweep(feature))for(const auto& field:{"sweepProfile","sweepPath"}){const auto reference=JsonParser(feature.StringParameters.at(field)).Parse();sweepConsumers[{reference.GetString("featureId"),reference.GetString("bodyId")}].insert(index);}}
  std::set<LoftSectionKey> appliedSweepSelections;std::set<std::string> repairedSweeps;std::string sweepInspection;
  for(const auto& [key,unused]:sweepEdits)repairedSweeps.insert(key.first);
  const auto captureSweepSource=[&](const FeatureNode& sourceFeature,const std::string& bodyId,const ReplayBody& source){
    const auto consumers=sweepConsumers.find({sourceFeature.Id,bodyId});if(consumers==sweepConsumers.end())return;
    const auto identity=myEntityIdentities.find(bodyId);std::string fingerprint;
    for(const auto consumer:consumers->second){auto& feature=replayDefinitions[consumer];for(const auto& slot:CurveSweepInputs(feature)){
      const LoftSectionKey key{feature.Id,slot.Id};const bool inspecting=inspectionTarget.FeatureId==key.first && inspectionTarget.SweepInputId==key.second;const auto override=sweepEdits.find(key);
      if(!namingUpgrade && !inspecting && override==sweepEdits.end())continue;
      auto reference=JsonParser(feature.StringParameters.at(slot.Field)).Parse();if(reference.GetString("featureId")!=sourceFeature.Id || reference.GetString("bodyId")!=bodyId)continue;
      if(identity==myEntityIdentities.end() || identity->second.Body!=reference.GetString("bodyIdentity") || sourceFeature.Identity!=reference.GetString("featureIdentity"))throw CurveSweepInputFailure(key.first,key.second,slot.Kind,"Historical sweep source identity does not match.");
      if(fingerprint.empty())fingerprint=ShapeFingerprint(source.Shape);
      const auto selector=[&]()->std::string{return slot.EdgeIndex<0?reference.GetString("selector"):reference.At("edges").AsArray().at(slot.EdgeIndex).GetString("selector");};
      if(namingUpgrade){
        auto retained=selector();namingUpgrade->rebind("sweep/"+feature.Id+"/"+slot.Id,source.Shape,source.Names,slot.Kind,retained);
        if(slot.EdgeIndex<0)reference.ChangeObject()["selector"]=JsonValue(retained);
        else reference.ChangeObject()["edges"].ChangeArray().at(slot.EdgeIndex).ChangeObject()["selector"]=JsonValue(retained);
        StoreCurveSweepReference(feature,slot.Field,reference);
      }
      if(override!=sweepEdits.end()){
        const auto& edit=override->second;
        if(edit.GetString("documentId")!=myDocumentId || edit.GetString("kind")!=slot.Kind || edit.GetString("sourceBodyId")!=bodyId || edit.GetString("sourceBodyIdentity")!=identity->second.Body || edit.GetString("sourceFeatureId")!=sourceFeature.Id || edit.GetString("inputFingerprint")!=fingerprint)
          throw CadError("STALE_SELECTION_REPAIR","The historical sweep input changed. Inspect it again; no index fallback was used.");
        const int index=edit.GetInteger("index");const auto captured=TopologyNaming::CaptureSelection(source.Shape,source.Names,slot.Kind,index);
        if(slot.EdgeIndex<0)reference.ChangeObject()["selector"]=JsonValue(captured);
        else{auto& edge=reference.ChangeObject()["edges"].ChangeArray().at(slot.EdgeIndex);edge.ChangeObject()["inputId"]=JsonValue(slot.Id);edge.ChangeObject()["selector"]=JsonValue(captured);ShapeSerializer topology(source.Shape,0,bodyId);edge.ChangeObject()["orientation"]=JsonValue(std::string(topology.Edges()(index).Orientation()==TopAbs_REVERSED?"reversed":"forward"));}
        StoreCurveSweepReference(feature,slot.Field,reference);appliedSweepSelections.insert(key);
      }
      if(inspecting){
        bool sameSource=false;const auto old=std::find_if(myFeatures.begin(),myFeatures.end(),[&](const auto& item){return item.Id==feature.Id;});
        if(old!=myFeatures.end()){const auto previous=JsonParser(old->StringParameters.at(slot.Field)).Parse();sameSource=previous.GetString("featureId")==sourceFeature.Id && previous.GetString("featureIdentity")==sourceFeature.Identity && previous.GetString("bodyId")==bodyId && previous.GetString("bodyIdentity")==identity->second.Body;}
        int index=0;std::string state="unverified",diagnostic="Select the intended historical input.";
        if(sameSource || override!=sweepEdits.end())try{index=TopologyNaming::ResolveSelection(source.Shape,source.Names,selector());state="resolved";diagnostic.clear();}catch(const CadError& error){state="unresolved";diagnostic=error.what();}
        auto response=JsonValue::MakeObject();auto& fields=response.ChangeObject();fields["ok"]=JsonValue(true);fields["protocolVersion"]=JsonValue(1.0);fields["requestId"]=JsonValue(requestId);fields["documentId"]=JsonValue(myDocumentId);fields["revision"]=JsonValue(static_cast<double>(myRevision));
        auto preview=JsonValue::MakeObject();auto& p=preview.ChangeObject();p["featureId"]=JsonValue(feature.Id);p["sweepInputId"]=JsonValue(slot.Id);p["featureType"]=JsonValue(feature.Type);p["sourceBodyId"]=JsonValue(bodyId);p["sourceBodyIdentity"]=JsonValue(identity->second.Body);p["sourceFeatureId"]=JsonValue(sourceFeature.Id);p["kind"]=JsonValue(slot.Kind);p["inputFingerprint"]=JsonValue(fingerprint);p["selectionState"]=JsonValue(state);p["resolvedIndex"]=JsonValue(static_cast<double>(index));p["diagnostic"]=JsonValue(diagnostic);
        ShapeSerializationLimits limits;limits.maxTriangles=100000;limits.maxEdges=5000;limits.edgeSamples=33;ShapeSerializer serializer(source.Shape,0,bodyId,limits);
        auto encoded=JsonSerialize(preview);encoded.pop_back();encoded+=",\"presentation\":"+serializer.SerializeBody()+"}";auto prefix=JsonSerialize(response);prefix.pop_back();sweepInspection=prefix+",\"inputPreview\":"+encoded+"}";
      }
    }}
  };
  std::map<std::pair<std::string,std::string>,std::set<std::size_t>> loftConsumers;
  for(std::size_t index=0;index<replayDefinitions.size();++index){const auto& definition=replayDefinitions[index];if(definition.Type=="detail.loft" && IsProfileLoft(definition)){
    const auto references=JsonParser(definition.StringParameters.at("loftSections")).Parse();
    for(const auto& reference:references.AsArray()){const auto key=std::make_pair(reference.GetString("featureId"),reference.GetString("bodyId"));loftSources.insert(key);loftConsumers[key].insert(index);}
  }}
  std::map<std::pair<std::string,std::string>,ReplayBody> loftOutputs;
  std::set<LoftSectionKey> appliedLoftSelections;
  std::set<std::string> repairedLofts;
  for(const auto& [key,unused]:loftEdits)repairedLofts.insert(key.first);
  std::string loftInspection;
  const auto captureLoftSource=[&](const FeatureNode& sourceFeature,const std::string& bodyId,const ReplayBody& source)
  {
    const auto identity=myEntityIdentities.find(bodyId);
    const auto consumers=loftConsumers.find({sourceFeature.Id,bodyId});if(consumers==loftConsumers.end())return;
    for(const auto index:consumers->second){auto& feature=replayDefinitions[index];
      auto sections=loftSections(feature);bool changed=false;
      for(auto& section:sections.ChangeArray()){
        if(section.GetString("featureId")!=sourceFeature.Id || section.GetString("bodyId")!=bodyId)continue;
        const LoftSectionKey key{feature.Id,section.GetString("sectionId")};
        const bool inspecting=inspectionTarget.FeatureId==key.first && inspectionTarget.SectionId==key.second;
        const auto override=loftEdits.find(key);
        if(!namingUpgrade && override==loftEdits.end() && !inspecting)continue;
        if(identity==myEntityIdentities.end() || identity->second.Body!=section.GetString("bodyIdentity") || sourceFeature.Identity!=section.GetString("featureIdentity"))
          throw loftSectionFailure(key.first,key.second,"Historical section identity does not match the selected source.");
        const auto fingerprint=ShapeFingerprint(source.Shape);
        if(namingUpgrade){
          auto selector=section.GetString("selector");namingUpgrade->rebind("loft/"+feature.Id+"/"+key.second+"/face",source.Shape,source.Names,"face",selector);
          section.ChangeObject()["selector"]=JsonValue(selector);
          if(section.Has("holeSelectors"))for(std::size_t hole=0;hole<section.At("holeSelectors").AsArray().size();++hole){
            auto retained=section.At("holeSelectors").AsArray()[hole].AsString();
            namingUpgrade->rebind("loft/"+feature.Id+"/"+key.second+"/hole/"+std::to_string(hole),source.Shape,source.Names,"edge",retained);
            section.ChangeObject()["holeSelectors"].ChangeArray()[hole]=JsonValue(retained);
          }
          changed=true;
        }
        if(override!=loftEdits.end()){
          const auto& edit=override->second;
          if(edit.GetString("documentId")!=myDocumentId || edit.GetString("kind")!="face" || edit.GetString("sourceBodyId")!=bodyId
            || edit.GetString("sourceBodyIdentity")!=identity->second.Body || edit.GetString("sourceFeatureId")!=sourceFeature.Id || edit.GetString("inputFingerprint")!=fingerprint)
            throw CadError("STALE_SELECTION_REPAIR","The selected Loft section source changed. Inspect the historical Face again; no index fallback was used.");
          section.ChangeObject()["selector"]=JsonValue(TopologyNaming::CaptureSelection(source.Shape,source.Names,"face",edit.GetInteger("index")));
          if(edit.Has("holeIndexes")){
            const auto& indexes=edit.At("holeIndexes");const auto expected=section.Has("holeSelectors")?section.At("holeSelectors").AsArray().size():0;
            if(!indexes.IsArray() || indexes.AsArray().size()!=expected || expected>16)throw CadError("INVALID_LOFT_HOLE_MAPPING","Historical repair must explicitly retain one slot per existing through-hole.");
            auto selectors=JsonValue::MakeArray();std::set<int> unique;
            for(const auto& item:indexes.AsArray()){
              if(!item.IsNumber() || item.AsNumber()!=std::floor(item.AsNumber()) || item.AsNumber()<1 || item.AsNumber()>5000)throw CadError("INVALID_LOFT_HOLE_MAPPING","Historical hole selections require actual displayed Edge indexes.");
              const int selected=static_cast<int>(item.AsNumber());if(!unique.insert(selected).second)throw CadError("INVALID_LOFT_HOLE_MAPPING","Historical hole slots cannot repeat one boundary seed.");
              selectors.ChangeArray().push_back(JsonValue(TopologyNaming::CaptureSelection(source.Shape,source.Names,"edge",selected)));
            }
            if(expected)section.ChangeObject()["holeSelectors"]=selectors;
          }
          // Check wire membership at the exact proposed historical output,
          // not against the currently visible final Body.
          if(section.Has("holeSelectors"))ResolveLoftProfile(source.Shape,source.Names,section);
          appliedLoftSelections.insert(key);changed=true;
        }
        if(inspecting){
          bool sameSource=false;
          const auto original=std::find_if(myFeatures.begin(),myFeatures.end(),[&](const auto& item){return item.Id==feature.Id;});
          if(original!=myFeatures.end()){
            const auto previous=loftSections(*original);
            for(const auto& old:previous.AsArray())if(old.GetString("sectionId")==key.second)
              sameSource=old.GetString("featureId")==sourceFeature.Id && old.GetString("featureIdentity")==sourceFeature.Identity
                && old.GetString("bodyId")==bodyId && old.GetString("bodyIdentity")==identity->second.Body;
          }
          int index=0;std::string state="unverified",diagnostic="Select the intended Face in this historical output.";
          if(sameSource || override!=loftEdits.end())try{index=TopologyNaming::ResolveSelection(source.Shape,source.Names,section.GetString("selector"));state="resolved";diagnostic.clear();}
            catch(const CadError& error){state="unresolved";diagnostic=error.what();}
          ShapeSerializationLimits limits;limits.maxTriangles=100000;limits.maxEdges=5000;limits.edgeSamples=33;
          ShapeSerializer serializer(source.Shape,0,bodyId,limits);
          auto preview=JsonValue::MakeObject();auto& p=preview.ChangeObject();p["featureId"]=JsonValue(feature.Id);p["sectionId"]=JsonValue(key.second);p["featureType"]=JsonValue(feature.Type);
          p["faceBoundaries"]=FaceBoundaryTable(serializer);
          p["requiredHoleCount"]=JsonValue(static_cast<double>(section.Has("holeSelectors")?section.At("holeSelectors").AsArray().size():0));
          auto selectedHoles=JsonValue::MakeArray();
          if(section.Has("holeSelectors"))for(const auto& stored:section.At("holeSelectors").AsArray()){
            int selected=0;if(sameSource || override!=loftEdits.end())try{selected=TopologyNaming::ResolveSelection(source.Shape,source.Names,stored.AsString());}catch(const CadError&){/* Explicit mapping remains required. */}
            selectedHoles.ChangeArray().push_back(JsonValue(static_cast<double>(selected)));
          }
          p["selectedHoleIndexes"]=selectedHoles;
          auto response=JsonValue::MakeObject();auto& fields=response.ChangeObject();fields["ok"]=JsonValue(true);fields["protocolVersion"]=JsonValue(1.0);
          fields["requestId"]=JsonValue(requestId);fields["documentId"]=JsonValue(myDocumentId);fields["revision"]=JsonValue(static_cast<double>(myRevision));
          p["sourceBodyId"]=JsonValue(bodyId);p["sourceBodyIdentity"]=JsonValue(identity->second.Body);p["sourceFeatureId"]=JsonValue(sourceFeature.Id);
          p["kind"]=JsonValue(std::string("face"));p["inputFingerprint"]=JsonValue(fingerprint);p["selectionState"]=JsonValue(state);p["resolvedIndex"]=JsonValue(static_cast<double>(index));p["diagnostic"]=JsonValue(diagnostic);
          auto encoded=JsonSerialize(preview);encoded.pop_back();encoded+=",\"presentation\":"+serializer.SerializeBody()+"}";
          auto prefix=JsonSerialize(response);prefix.pop_back();loftInspection=prefix+",\"inputPreview\":"+encoded+"}";
        }
      }
      if(changed)storeLoftSections(feature,sections);
    }
  };
  std::set<std::string> appliedCoordinates;
  std::string coordinateInspection;
  const auto refreshCoordinates=[&](const FeatureNode& feature)
  {
    const auto records=replayCoordinates.Records();
    for (auto [id,record]:records)
    {
      if (record.AssociationMode!="associative" || record.ReferenceFeatureId!=feature.Id) continue;
      const auto source=replayBodies.find(record.ReferenceBodyId);
      const auto identity=myEntityIdentities.find(record.ReferenceBodyId);
      if (feature.State!="suppressed" && feature.Identity==record.ReferenceFeatureIdentity
          && source!=replayBodies.end() && source->second.SourceFeatureId==feature.Id
          && identity!=myEntityIdentities.end() && identity->second.Body==record.ReferenceBodyIdentity)
      {
        const auto fingerprint=coordinateEdits.count(id) || inspectionTarget.CoordinateId==id?ShapeFingerprint(source->second.Shape):std::string();
        if(const auto override=coordinateEdits.find(id);override!=coordinateEdits.end())
        {
          const auto& edit=override->second;
          if(edit.GetString("documentId")!=myDocumentId || edit.GetString("sourceBodyIdentity")!=identity->second.Body
              || edit.GetString("kind")!="face" || edit.GetString("sourceBodyId")!=record.ReferenceBodyId
              || edit.GetString("sourceFeatureId")!=feature.Id || edit.GetString("inputFingerprint")!=fingerprint)
            throw CadError("STALE_SELECTION_REPAIR","坐标系历史来源已变化，请重新读取并选择实际面；未使用旧面编号。");
          const int selectedIndex=edit.GetInteger("index");
          record.ReferenceSelector=TopologyNaming::CaptureSelection(source->second.Shape,source->second.Names,"face",selectedIndex);
          record.ReferenceTopologyId="face-0-"+std::to_string(selectedIndex);
          appliedCoordinates.insert(id);
        }
        if(namingUpgrade)namingUpgrade->rebind("coordinate/"+id,source->second.Shape,source->second.Names,"face",record.ReferenceSelector);
        ResolveFaceCoordinate(record,source->second.Shape,source->second.Names);
        if(inspectionTarget.CoordinateId==id)
        {
          const auto& original=myCoordinateSystems.Records().at(id);
          const bool sameSource=original.ReferenceFeatureId==feature.Id && original.ReferenceBodyId==record.ReferenceBodyId
            && original.ReferenceFeatureIdentity==feature.Identity && original.ReferenceBodyIdentity==identity->second.Body;
          const bool canLocate=sameSource || coordinateEdits.count(id);
          ShapeSerializationLimits limits;limits.maxTriangles=100000;limits.maxEdges=5000;limits.edgeSamples=33;
          ShapeSerializer serializer(source->second.Shape,0,record.ReferenceBodyId,limits);
          coordinateInspection="{\"ok\":true,\"protocolVersion\":1,\"requestId\":\""+JsonEscape(requestId)
            +"\",\"documentId\":\""+JsonEscape(myDocumentId)+"\",\"revision\":"+std::to_string(myRevision)
            +",\"inputPreview\":{\"coordinateSystemId\":\""+JsonEscape(id)+"\",\"featureId\":\""+JsonEscape(feature.Id)
            +"\",\"featureType\":\"coordinate.face\",\"sourceBodyId\":\""+JsonEscape(record.ReferenceBodyId)
            +"\",\"sourceBodyIdentity\":\""+JsonEscape(identity->second.Body)+"\",\"sourceFeatureId\":\""+JsonEscape(feature.Id)
            +"\",\"kind\":\"face\",\"inputFingerprint\":\""+fingerprint+"\",\"selectionState\":\""+(canLocate?record.ReferenceState:"unverified")
            +"\",\"resolvedIndex\":"+std::to_string(canLocate?record.ResolvedFaceIndex:0)+",\"diagnostic\":\""+JsonEscape(record.ReferenceDiagnostic)
            +"\",\"presentation\":"+serializer.SerializeBody()+"}}";
        }
      }
      else
      {
        record.ReferenceState="unresolved";record.ResolvedFaceIndex=0;
        record.ReferenceDiagnostic="来源特征被抑制、历史输出已不存在或身份不匹配。";
      }
      replayCoordinates.Set(record);
      if(inspectionTarget.CoordinateId==id && coordinateInspection.empty())
        throw CadError("FEATURE_INPUT_UNAVAILABLE","坐标系历史来源没有有效输出，请选择其他特征及输出 Body。");
    }
  };
  std::set<std::string> affectedFeatures;
  std::map<std::string, std::map<std::string, std::string>> selectionReferences;
  std::set<std::string> appliedSelections;
  const auto resolveSelection = [&](FeatureNode& feature, const ReplayBody& source)
  {
    if(namingUpgrade && !referenceKind(feature).empty()){
      const auto kind=referenceKind(feature),key="selection."+kind+"Id";
      auto stored=feature.StringParameters.find(key);
      if(stored==feature.StringParameters.end()){
        // Final geometry equality cannot certify an undocumented historical
        // selection (e.g. a downstream Boolean may hide the difference).
        throw CadError("IMPORT_NAMING_UPGRADE_REFERENCE_MISSING","A historical feature has no persistent selection proof. Inspect and explicitly repair its input before upgrading.");
      }
      namingUpgrade->rebind("feature/"+feature.Id+"/"+kind,source.Shape,source.Names,kind,stored->second);
    }
    try { prepareSelection(feature, source); }
    catch (const CadError& error)
    {
      if (error.Code() != "FEATURE_SELECTION_UNVERIFIED" && error.Code() != "FEATURE_SELECTION_UNRESOLVED") throw;
      throw CadError(error.Code(), error.what(), "{\"featureId\":\"" + JsonEscape(feature.Id)
        + "\",\"selectionKind\":\"" + referenceKind(feature) + "\",\"sourceBodyId\":\"" + JsonEscape(referenceBody(feature))
        + "\",\"sourceFeatureId\":\"" + JsonEscape(source.SourceFeatureId) + "\"}");
    }
    for (const auto& [key, value] : feature.StringParameters)
      if (key.rfind("selection.", 0) == 0) selectionReferences[feature.Id][key] = value;
  };
  for (const std::size_t index:replayOrder)
  {
    FeatureNode& feature = replayDefinitions[index];
    if (feature.State != "suppressed") preparePatternDefinition(feature);
    const bool coordinateChanged=feature.State!="suppressed" && ApplyFeatureCoordinates(feature,replayCoordinates);
    const bool directlyEdited = !namingUpgrade && (recomputeAll || index == editedIndex || selectionEdits.count(feature.Id) || repairedLofts.count(feature.Id) || repairedSweeps.count(feature.Id) || coordinateChanged);
    if ((inspectionTarget.SectionId.empty() && inspectionTarget.SweepInputId.empty() && feature.Id == inspectionTarget.FeatureId) || selectionEdits.count(feature.Id))
    {
      const auto kind = referenceKind(feature), bodyId = referenceBody(feature);
      const auto source = replayBodies.find(bodyId);
      if (kind.empty() || source == replayBodies.end()) throw CadError("FEATURE_INPUT_UNAVAILABLE", "The historical feature input is not available.");
      const auto fingerprint = ShapeFingerprint(source->second.Shape);
      const auto identity = myEntityIdentities.find(bodyId);
      if (identity == myEntityIdentities.end()) throw CadError("FEATURE_INPUT_UNAVAILABLE", "The historical input has no document-scoped body identity.");
      if (const auto override = selectionEdits.find(feature.Id); override != selectionEdits.end())
      {
        const auto& edit = override->second;
        if (edit.GetString("documentId") != myDocumentId || edit.GetString("sourceBodyIdentity") != identity->second.Body
          || edit.GetString("kind") != kind || edit.GetString("sourceBodyId") != bodyId
          || edit.GetString("sourceFeatureId") != source->second.SourceFeatureId || edit.GetString("inputFingerprint") != fingerprint)
          throw CadError("STALE_SELECTION_REPAIR", "The selected historical input changed. Inspect it again; no index fallback was used.");
        const int selectedIndex = edit.GetInteger("index");
        const std::string field = kind + "Id", key = "selection." + field;
        feature.StringParameters[key] = TopologyNaming::CaptureSelection(source->second.Shape, source->second.Names, kind, selectedIndex);
        feature.StringParameters[field] = kind + "-0-" + std::to_string(selectedIndex);
        selectionReferences[feature.Id][key] = feature.StringParameters[key];
        selectionReferences[feature.Id][field] = feature.StringParameters[field];
        appliedSelections.insert(feature.Id);
      }
      if (feature.Id == inspectionTarget.FeatureId)
      {
        int resolvedIndex = 0; std::string selectionState = "unverified", diagnostic;
        const auto stored = feature.StringParameters.find("selection." + kind + "Id");
        if (stored != feature.StringParameters.end())
          try { resolvedIndex = TopologyNaming::ResolveSelection(source->second.Shape, source->second.Names, stored->second); selectionState = "resolved"; }
          catch (const CadError& error) { selectionState = "unresolved"; diagnostic = error.what(); }
        ShapeSerializationLimits limits; limits.maxTriangles = 100000; limits.maxEdges = 5000; limits.edgeSamples = 33;
        ShapeSerializer serializer(source->second.Shape, 0, bodyId, limits);
        return "{\"ok\":true,\"protocolVersion\":1,\"requestId\":\"" + JsonEscape(requestId)
          + "\",\"documentId\":\"" + JsonEscape(myDocumentId) + "\",\"revision\":" + std::to_string(myRevision)
          + ",\"inputPreview\":{\"featureId\":\"" + JsonEscape(feature.Id)
          + "\",\"featureType\":\"" + JsonEscape(feature.Type) + "\",\"sourceBodyId\":\"" + JsonEscape(bodyId)
          + "\",\"sourceBodyIdentity\":\"" + JsonEscape(identity->second.Body)
          + "\",\"sourceFeatureId\":\"" + JsonEscape(source->second.SourceFeatureId) + "\",\"kind\":\"" + kind
          + "\",\"inputFingerprint\":\"" + fingerprint + "\",\"selectionState\":\"" + selectionState
          + "\",\"resolvedIndex\":" + std::to_string(resolvedIndex) + ",\"diagnostic\":\"" + JsonEscape(diagnostic)
          + "\",\"presentation\":" + serializer.SerializeBody() + "}}";
      }
    }
    if (feature.State == "suppressed")
    {
      if(namingUpgrade && !referenceKind(feature).empty()){
        const auto source=replayBodies.find(referenceBody(feature));
        if(source==replayBodies.end())throw CadError("IMPORT_NAMING_UPGRADE_REFERENCE_MISSING","Suppressed feature input is unavailable for verification.");
        resolveSelection(feature,source->second);
      }
      const bool unary = (feature.Type.rfind("transform.", 0) == 0 && feature.Type != "transform.copy")
        || feature.Type == "detail.fillet" || feature.Type == "detail.chamfer"
        || feature.Type == "detail.shell" || feature.Type == "detail.offset" || feature.Type == "detail.draft";
      if (unary)
      {
        if (feature.OutputBodies.size() != 1 || feature.InputFeatures.size() != 1)
          throw CadError("INVALID_FEATURE_GRAPH", "Suppressed unary feature must have one input and one output.");
        const auto body = replayBodies.find(feature.OutputBodies.front());
        if (body == replayBodies.end())
          throw CadError("INVALID_FEATURE_GRAPH", "Suppressed feature input body is unavailable during replay.");
        body->second.Affected = directlyEdited || body->second.Affected;
      }
      else if(feature.Type=="detail.loft" || ((feature.Type=="detail.sweep" || feature.Type=="detail.pipe") && IsCurveSweep(feature)))
      {
        // Loft retains all source Bodies. Suppression emits no result and must
        // not demand the unary sourceBody field that a Loft never stores.
      }
      else if (feature.Type == "detail.thicken" || feature.Type == "detail.revolve" || feature.Type == "detail.sweep" || feature.Type == "detail.pipe" || feature.Type == "pattern.linear" || feature.Type == "pattern.circular" || feature.Type == "pattern.rectangular" || feature.Type == "pattern.mirror")
      {
        const auto source = replayBodies.find(textParameter(feature, "sourceBody"));
        if (source == replayBodies.end())
          throw CadError("INVALID_FEATURE_GRAPH", "Suppressed Thicken source Body is unavailable during replay.");
        // Patterns can reuse the original Body as their first output. On
        // suppression that live Body must return to its actual predecessor;
        // otherwise its shape/source metadata still claims the suppressed node.
        if(std::find(feature.OutputBodies.begin(),feature.OutputBodies.end(),textParameter(feature,"sourceBody"))!=feature.OutputBodies.end())
          source->second.Affected=directlyEdited||source->second.Affected;
      }
      else if (isBooleanType(feature.Type))
      {
        std::vector<std::string> inputBodyIds = storedBodyIds(feature, "targetBodies", "targetBody");
        const std::vector<std::string> toolBodyIds = storedBodyIds(feature, "toolBodies", "toolBody");
        inputBodyIds.insert(inputBodyIds.end(), toolBodyIds.begin(), toolBodyIds.end());
        for (const std::string& bodyId : inputBodyIds)
        {
          auto body = replayBodies.find(bodyId);
          if (body == replayBodies.end())
            throw CadError("INVALID_FEATURE_GRAPH", "Suppressed Boolean input body is unavailable during replay.");
          body->second.Affected = true;
          body->second.ComplexTopology = true;
          applyStoredMetadata(body->second, feature, "inputBodyMeta", bodyId);
        }
      }
      else
      {
        throw CadError("FEATURE_LIFECYCLE_UNSUPPORTED", "This feature type cannot be suppressed.");
      }
      bool featureAffected = directlyEdited;
      for (const std::string& input : feature.InputFeatures)
        if (affectedFeatures.find(input) != affectedFeatures.end()) featureAffected = true;
      if (featureAffected) affectedFeatures.insert(feature.Id);
      refreshCoordinates(feature);
      if(!coordinateInspection.empty())return coordinateInspection;
      continue;
    }
    if (feature.Type == "import.step")
    {
      const std::vector<TopoDS_Shape> shapes = buildImportedShapes(feature);
      if(namingUpgrade && namingUpgrade->Upgrading && !feature.NumberParameters.count("importNamingVersion"))feature.NumberParameters["importNamingVersion"]=1;
      const auto namingVersion=feature.NumberParameters.find("importNamingVersion");
      if(namingVersion!=feature.NumberParameters.end() && namingVersion->second!=1.0)
        throw CadError("STEP_NAMING_VERSION_UNSUPPORTED","Unsupported imported topology naming version.");
      if(namingVersion!=feature.NumberParameters.end() && (number(feature,"decompositionVersion")!=2.0 || textParameter(feature,"sourceFingerprintAlgorithm")!="sha256-chain-1m-v1"))
        throw CadError("INVALID_NAMING_SOURCE","Imported topology naming requires verified versioned STEP sources.");
      for (std::size_t bodyIndex = 0; bodyIndex < feature.OutputBodies.size(); ++bodyIndex)
      {
        const auto& bodyId=feature.OutputBodies[bodyIndex];
        ReplayBody replay{shapes[bodyIndex],feature.Id,directlyEdited,false};
        // No silent upgrade of old imports: their existing selectors and
        // attributes retain the legacy exact-shape-only behavior.
        if(namingVersion!=feature.NumberParameters.end())
          replay.Names=TopologyNaming::ImportedSource(shapes[bodyIndex],feature.Id,bodyId,textParameter(feature,"sourceFingerprint"));
        applyStoredMetadata(replay,feature,"outputBodyMeta",bodyId);
        replayBodies[bodyId]=std::move(replay);
      }
    }
    else if (feature.Type.rfind("primitive.", 0) == 0 || feature.Type.rfind("surface.", 0) == 0)
    {
      if (feature.OutputBodies.size() != 1)
        throw CadError("INVALID_FEATURE_GRAPH", "Source feature must produce exactly one body.");
      const auto built=occweb::BuildNamedPrimitive(feature);
      ReplayBody replay{built.Shape,feature.Id,directlyEdited,false};replay.Names=built.Names;
      applyStoredMetadata(replay,feature,"outputBodyMeta",feature.OutputBodies.front());
      replayBodies[feature.OutputBodies.front()]=std::move(replay);
    }
    else if (feature.Type == "detail.thicken")
    {
      if (feature.OutputBodies.size() != 1 || feature.InputFeatures.size() != 1)
        throw CadError("INVALID_FEATURE_GRAPH", "Thicken feature must have one input and one output.");
      const std::string sourceBodyId = textParameter(feature, "sourceBody");
      const auto source = replayBodies.find(sourceBodyId);
      if (source == replayBodies.end())
        throw CadError("INVALID_FEATURE_GRAPH", "Thicken source Body is unavailable during replay.");
      resolveSelection(feature, source->second);
      auto names=source->second.Names;
      ReplayBody output{applyOffsetDetail(source->second.Shape, feature,&names), feature.Id,
                        directlyEdited || source->second.Affected, true};
      applyStoredMetadata(output, feature, "outputBodyMeta", feature.OutputBodies.front());
      output.Names=std::move(names);
      replayBodies[feature.OutputBodies.front()] = std::move(output);
    }
    else if (feature.Type == "detail.sweep" || feature.Type == "detail.pipe")
    {
      if(IsCurveSweep(feature)){
        if(feature.OutputBodies.size()!=1 || feature.InputFeatures.empty())throw CadError("INVALID_FEATURE_GRAPH","A curved sweep requires source features and one output.");
        const auto resolve=[&](const std::string& field)->const ReplayBody&{
          const auto reference=JsonParser(feature.StringParameters.at(field)).Parse();const auto sourceId=reference.GetString("featureId"),bodyId=reference.GetString("bodyId");const auto source=sweepOutputs.find({sourceId,bodyId});const auto identity=myEntityIdentities.find(bodyId);
          const auto definition=std::find_if(replayDefinitions.begin(),replayDefinitions.end(),[&](const auto& candidate){return candidate.Id==sourceId;});
          if(source==sweepOutputs.end() || identity==myEntityIdentities.end() || identity->second.Body!=reference.GetString("bodyIdentity") || definition==replayDefinitions.end() || definition->Identity!=reference.GetString("featureIdentity")){
            const auto slots=CurveSweepInputs(feature);const auto slot=std::find_if(slots.begin(),slots.end(),[&](const auto& item){return item.Field==field;});
            throw CurveSweepInputFailure(feature.Id,slot->Id,slot->Kind,"The sweep's historical source was deleted, suppressed or replaced. Reselect its historical input; final live Bodies are not substituted.");
          }
          return source->second;
        };
        const auto& profileSource=resolve("sweepProfile");const auto& pathSource=resolve("sweepPath");
        const auto profile=[&](){try{return ResolveSweepProfile(profileSource.Shape,profileSource.Names,JsonParser(feature.StringParameters.at("sweepProfile")).Parse());}catch(const CadError& error){if(error.Code()=="FEATURE_SELECTION_UNRESOLVED" || error.Code()=="FEATURE_SELECTION_UNVERIFIED")throw CurveSweepInputFailure(feature.Id,"profile","face",error.what());throw;}}();
        const auto built=BuildCurveSweep(profile,ResolveSweepPath(pathSource.Shape,pathSource.Names,JsonParser(feature.StringParameters.at("sweepPath")).Parse(),feature.Id),feature);
        ReplayBody output{built.Shape,feature.Id,directlyEdited || profileSource.Affected || pathSource.Affected,true};output.Names=built.Names;applyStoredMetadata(output,feature,"outputBodyMeta",feature.OutputBodies.front());replayBodies[feature.OutputBodies.front()]=std::move(output);
      }else{
      if (feature.OutputBodies.size() != 1 || feature.InputFeatures.size() != 1) throw CadError("INVALID_FEATURE_GRAPH", "Sweep feature must have one input and one output.");
      const auto source = replayBodies.find(textParameter(feature, "sourceBody"));
      if (source == replayBodies.end()) throw CadError("INVALID_FEATURE_GRAPH", "Sweep source Body is unavailable during replay.");
      resolveSelection(feature, source->second);
      auto names=source->second.Names;
      ReplayBody output{applySweep(source->second.Shape, feature,&names), feature.Id, directlyEdited || source->second.Affected, true};output.Names=std::move(names);
      applyStoredMetadata(output, feature, "outputBodyMeta", feature.OutputBodies.front());
      replayBodies[feature.OutputBodies.front()] = std::move(output);
      }
    }
    else if (feature.Type == "detail.loft")
    {
      if(feature.OutputBodies.size()!=1 || feature.InputFeatures.empty())throw CadError("INVALID_FEATURE_GRAPH","Loft requires source features and one output.");
      bool affected=directlyEdited;TopoDS_Shape shape;TopologyNames names;
      if(IsProfileLoft(feature)){
        std::vector<LoftProfile> profiles;const auto references=JsonParser(feature.StringParameters.at("loftSections")).Parse();
        for(const auto& reference:references.AsArray()){
          const auto sourceId=reference.GetString("featureId"),bodyId=reference.GetString("bodyId");
          const auto source=loftOutputs.find({sourceId,bodyId});const auto identity=myEntityIdentities.find(bodyId);
          const auto definition=std::find_if(replayDefinitions.begin(),replayDefinitions.end(),[&](const auto& item){return item.Id==sourceId;});
          if(source==loftOutputs.end() || identity==myEntityIdentities.end() || identity->second.Body!=reference.GetString("bodyIdentity") || definition==replayDefinitions.end() || definition->Identity!=reference.GetString("featureIdentity"))
            throw loftSectionFailure(feature.Id,reference.GetString("sectionId"),"Loft section source was deleted, suppressed or replaced. Reselect the intended section; final live geometry is not a substitute.");
          try{profiles.push_back(ResolveLoftProfile(source->second.Shape,source->second.Names,reference));}
          catch(const CadError& error){throw loftSectionFailure(feature.Id,reference.GetString("sectionId"),error.what());}
          affected=affected||source->second.Affected;
        }
        const auto built=BuildLoft(profiles,feature);shape=built.Shape;names=built.Names;
      }else{
        std::vector<TopoDS_Shape> sections;
        for(const auto& id:splitBodyIds(textParameter(feature,"sectionBodies"))){const auto source=replayBodies.find(id);if(source==replayBodies.end())throw CadError("INVALID_FEATURE_GRAPH","Legacy Loft section Body is unavailable.");sections.push_back(source->second.Shape);affected=affected||source->second.Affected;}
        shape=BuildLegacyLoft(sections,number(feature,"sectionSpacing",10));
      }
      ReplayBody output{shape,feature.Id,affected,true};output.Names=std::move(names);
      applyStoredMetadata(output, feature, "outputBodyMeta", feature.OutputBodies.front());
      replayBodies[feature.OutputBodies.front()] = std::move(output);
    }    else if (feature.Type == "detail.revolve")
    {
      if (feature.OutputBodies.size() != 1 || feature.InputFeatures.size() != 1)
        throw CadError("INVALID_FEATURE_GRAPH", "Revolve feature must have one input and one output.");
      const std::string sourceBodyId = textParameter(feature, "sourceBody");
      const auto source = replayBodies.find(sourceBodyId);
      if (source == replayBodies.end())
        throw CadError("INVALID_FEATURE_GRAPH", "Revolve source Body is unavailable during replay.");
      resolveSelection(feature, source->second);
      auto names=source->second.Names;
      ReplayBody output{applyRevolve(source->second.Shape, feature,&names), feature.Id,
                        directlyEdited || source->second.Affected, true};
      output.Names=std::move(names);
      applyStoredMetadata(output, feature, "outputBodyMeta", feature.OutputBodies.front());
      replayBodies[feature.OutputBodies.front()] = std::move(output);
    }
    else if (feature.Type == "pattern.linear" || feature.Type == "pattern.circular" || feature.Type == "pattern.rectangular" || feature.Type == "pattern.mirror")
    {
      if (feature.OutputBodies.size() < 2 || feature.InputFeatures.size() != 1)
        throw CadError("INVALID_FEATURE_GRAPH", "Linear pattern feature must have one input and at least two outputs.");
      const std::string sourceBodyId = textParameter(feature, "sourceBody");
      const auto source = replayBodies.find(sourceBodyId);
      if (source == replayBodies.end())
        throw CadError("INVALID_FEATURE_GRAPH", "Linear pattern source Body is unavailable during replay.");
      for (std::size_t index = 0; index < feature.OutputBodies.size(); ++index)
      {
        const std::string& outputBodyId = feature.OutputBodies[index];
        auto names=source->second.Names;
        ReplayBody output{feature.Type == "pattern.mirror" ? applyMirrorPattern(source->second.Shape, feature, static_cast<int>(index),&names) : feature.Type == "pattern.circular" ? applyCircularPattern(source->second.Shape, feature, static_cast<int>(index),&names) : feature.Type == "pattern.rectangular" ? applyRectangularPattern(source->second.Shape, feature, static_cast<int>(index),&names) : applyLinearPattern(source->second.Shape, feature, static_cast<int>(index),&names), feature.Id,
                          directlyEdited || source->second.Affected, source->second.ComplexTopology};
        output.Names=std::move(names);
        applyStoredMetadata(output, feature, "outputBodyMeta", outputBodyId);
        replayBodies[outputBodyId] = std::move(output);
      }
    }    else if (feature.Type == "transform.copy")
    {
      if (feature.OutputBodies.size() != 1 || feature.InputFeatures.size() != 1)
        throw CadError("INVALID_FEATURE_GRAPH", "Copy feature must have one input and one output.");
      const std::string sourceBodyId = textParameter(feature, "sourceBody");
      const auto source = replayBodies.find(sourceBodyId);
      if (source == replayBodies.end()) throw CadError("INVALID_FEATURE_GRAPH", "Copy source body is unavailable during replay.");
      auto names=source->second.Names;const auto shape=applyTransform(source->second.Shape,feature,&names);
      for(auto& [unused,origins]:names)for(auto& origin:origins)origin=feature.Id+"/copy/"+origin;
      ReplayBody copy{shape,feature.Id,directlyEdited || source->second.Affected,source->second.ComplexTopology};copy.Names=std::move(names);
      applyStoredMetadata(copy,feature,"outputBodyMeta",feature.OutputBodies.front());
      replayBodies[feature.OutputBodies.front()]=std::move(copy);
    }
    else if (feature.Type.rfind("transform.", 0) == 0 || feature.Type == "detail.fillet" || feature.Type == "detail.chamfer"
             || feature.Type == "detail.shell" || feature.Type == "detail.offset" || feature.Type == "detail.draft")
    {
      if (feature.OutputBodies.size() != 1 || feature.InputFeatures.size() != 1)
        throw CadError("INVALID_FEATURE_GRAPH", "Unary feature must have one input and one output.");
      const std::string& bodyId = feature.OutputBodies.front();
      auto body = replayBodies.find(bodyId);
      if (body == replayBodies.end())
        throw CadError("INVALID_FEATURE_GRAPH", "Unary feature input body is unavailable during replay.");
      const bool inputAffected = body->second.Affected;
      resolveSelection(feature, body->second);
      if (feature.Type == "detail.fillet")
        body->second.Shape = applyFillet(body->second.Shape, feature, &body->second.Names);
      else if (feature.Type == "detail.chamfer")
        body->second.Shape = applyChamfer(body->second.Shape, feature, &body->second.Names);
      else if (feature.Type == "detail.shell" || feature.Type == "detail.offset")
        body->second.Shape = applyOffsetDetail(body->second.Shape, feature,&body->second.Names);
      else if (feature.Type == "detail.draft")
        body->second.Shape = applyDraft(body->second.Shape, feature,&body->second.Names);
      else
        body->second.Shape = applyTransform(body->second.Shape, feature, &body->second.Names);
      body->second.SourceFeatureId = feature.Id;
      body->second.Affected = directlyEdited || inputAffected;
      body->second.ComplexTopology = body->second.ComplexTopology || feature.Type == "detail.fillet" || feature.Type == "detail.chamfer"
        || feature.Type == "detail.shell" || feature.Type == "detail.offset" || feature.Type == "detail.draft";
      applyStoredMetadata(body->second,feature,"outputBodyMeta",bodyId);
    }
    else if (feature.Type.rfind("boolean.", 0) == 0)
    {
      const auto targetList = feature.StringParameters.find("targetBodies");
      const auto toolList = feature.StringParameters.find("toolBodies");
      const std::vector<std::string> targetIds = targetList == feature.StringParameters.end()
        ? std::vector<std::string>{textParameter(feature, "targetBody")}
        : splitBodyIds(targetList->second);
      const std::vector<std::string> toolIds = toolList == feature.StringParameters.end()
        ? std::vector<std::string>{textParameter(feature, "toolBody")}
        : splitBodyIds(toolList->second);
      std::vector<TopoDS_Shape> targets;
      std::vector<TopoDS_Shape> tools;
      bool affected = directlyEdited;
      for (const std::string& id : targetIds)
      {
        const auto found = replayBodies.find(id);
        if (found == replayBodies.end()) throw CadError("INVALID_FEATURE_GRAPH", "Boolean Target is unavailable during replay.");
        targets.push_back(found->second.Shape); affected = affected || found->second.Affected;
      }
      for (const std::string& id : toolIds)
      {
        const auto found = replayBodies.find(id);
        if (found == replayBodies.end()) throw CadError("INVALID_FEATURE_GRAPH", "Boolean Tool is unavailable during replay.");
        tools.push_back(found->second.Shape); affected = affected || found->second.Affected;
      }
      const auto refine = feature.StringParameters.find("refine");
      const auto built=occweb::BuildBooleanOperation(feature.Type,targets,tools,refine != feature.StringParameters.end() && refine->second=="true");
      const auto& result=built.Shape;
      const auto split = feature.StringParameters.find("splitResults");
      const std::vector<TopoDS_Shape> outputShapes = replayBooleanOutputs(result, split != feature.StringParameters.end() && split->second == "true");
      if (outputShapes.size() != feature.OutputBodies.size())
        throw CadError("BUILD_FAILED", "Boolean result component count changed during recompute; the previous result remains active.");
      std::vector<occweb::TopologyNames> outputNames(outputShapes.size());
      std::vector<std::string> inputs=targetIds;inputs.insert(inputs.end(),toolIds.begin(),toolIds.end());
      for(std::size_t i=0;i<outputShapes.size();i++){
        for(const auto& id:inputs){const auto& source=replayBodies.at(id);occweb::TopologyNaming::Merge(outputNames[i],occweb::TopologyNaming::Propagate(source.Shape,source.Names,outputShapes[i],*built.History));}
        occweb::TopologyNaming::CompleteEdges(outputShapes[i],outputNames[i]);
      }
      if (feature.StringParameters.find("keepTarget") == feature.StringParameters.end()
          || textParameter(feature, "keepTarget") != "true")
        for (const std::string& id : targetIds) replayBodies.erase(id);
      if (textParameter(feature, "keepTool") != "true")
        for (const std::string& id : toolIds) replayBodies.erase(id);
      for (std::size_t outputIndex = 0; outputIndex < outputShapes.size(); ++outputIndex)
      {
        const std::string& outputBodyId = feature.OutputBodies[outputIndex];
        ReplayBody output{outputShapes[outputIndex], feature.Id, affected, true};
        output.Names=std::move(outputNames[outputIndex]);
        applyStoredMetadata(output, feature, "outputBodyMeta", outputBodyId);
        replayBodies[outputBodyId] = std::move(output);
      }
    }
    else
    {
      throw CadError("UNSUPPORTED_RECOMPUTE", "Feature graph contains a non-replayable feature: " + feature.Type);
    }

    if(namingUpgrade)for(const auto& bodyId:feature.OutputBodies){
      const auto output=replayBodies.find(bodyId);
      if(output!=replayBodies.end() && output->second.SourceFeatureId==feature.Id)namingUpgrade->observe(feature,bodyId,output->second.Shape);
    }
    bool featureAffected = directlyEdited;
    for (const std::string& input : feature.InputFeatures)
      if (affectedFeatures.find(input) != affectedFeatures.end()) featureAffected = true;
    if (featureAffected) affectedFeatures.insert(feature.Id);
    for(const auto& bodyId:feature.OutputBodies)if(loftSources.count({feature.Id,bodyId})){
      const auto output=replayBodies.find(bodyId);if(output!=replayBodies.end() && output->second.SourceFeatureId==feature.Id){loftOutputs[{feature.Id,bodyId}]=output->second;captureLoftSource(feature,bodyId,output->second);}
    }
    for(const auto& bodyId:feature.OutputBodies)if(sweepSources.count({feature.Id,bodyId})){
      const auto output=replayBodies.find(bodyId);if(output!=replayBodies.end() && output->second.SourceFeatureId==feature.Id){sweepOutputs[{feature.Id,bodyId}]=output->second;captureSweepSource(feature,bodyId,output->second);}
    }
    if(!sweepInspection.empty())return sweepInspection;
    if(!loftInspection.empty())return loftInspection;
    refreshCoordinates(feature);
    if(!coordinateInspection.empty())return coordinateInspection;
    if(namingUpgrade && feature.Id==namingUpgrade->ArchiveTarget){
      if(namingUpgrade->Upgrading && (namingUpgrade->VerifiedOutputs.size()!=namingUpgrade->Outputs.size() || namingUpgrade->ReboundSelections.size()!=namingUpgrade->Selections.size()))
        throw CadError("IMPORT_NAMING_UPGRADE_ARCHIVE_UNVERIFIED","Archive replay did not verify every ancestor output and selection.");
      for(const auto& bodyId:feature.OutputBodies){const auto body=replayBodies.find(bodyId);if(body!=replayBodies.end() && body->second.SourceFeatureId==feature.Id)namingUpgrade->ArchiveOutputs.emplace(bodyId,NamedTopologyBody{body->second.Shape,body->second.Names,0,feature.Id});}
      namingUpgrade->ArchiveDefinition=feature;namingUpgrade->ArchiveReached=true;namingUpgrade->Features=replayDefinitions;namingUpgrade->Coordinates=replayCoordinates;return "{}";
    }
  }

  if (!inspectionTarget.empty()) throw CadError("FEATURE_INPUT_UNAVAILABLE", "Historical input preview did not reach its target; the live document was not changed.");
  if (appliedSelections.size() != selectionEdits.size()) throw CadError("INVALID_SELECTION_REPAIR", "A repair refers to an unavailable feature.");
  if(appliedLoftSelections.size()!=loftEdits.size())throw CadError("INVALID_SELECTION_REPAIR","A Loft section repair source was not reached during complete replay.");
  if(appliedSweepSelections.size()!=sweepEdits.size())throw CadError("INVALID_SELECTION_REPAIR","A curved sweep repair source was not reached during complete replay.");
  if(appliedCoordinates.size()!=coordinateEdits.size())throw CadError("INVALID_SELECTION_REPAIR","A coordinate repair source was not reached during complete replay.");
  if(namingUpgrade){
    if(replayBodies.size()!=myBodies.size())throw CadError("IMPORT_NAMING_UPGRADE_GEOMETRY_CHANGED","Replayed live Body set differs from the project.");
    for(const auto& [id,body]:myBodies){
      const auto replay=replayBodies.find(id);
      if(replay==replayBodies.end() || replay->second.SourceFeatureId!=body.SourceFeatureId || ShapeFingerprint(replay->second.Shape)!=ShapeFingerprint(body.Shape))
        throw CadError("IMPORT_NAMING_UPGRADE_GEOMETRY_CHANGED","Exact live BRep verification failed; existing geometry and references were not changed.");
      if(namingUpgrade->Upgrading)namingUpgrade->Names[id]=replay->second.Names;
    }
    for(const auto& [id,old]:myCoordinateSystems.Records())if(old.AssociationMode=="associative"){
      const auto& current=replayCoordinates.Records().at(id);
      if(old.ReferenceState!=current.ReferenceState || old.Origin!=current.Origin || old.XAxis!=current.XAxis || old.YAxis!=current.YAxis)
        throw CadError("IMPORT_NAMING_UPGRADE_COORDINATE_CHANGED","An associative coordinate is unresolved or its frame changed during unchanged replay. Review its source before upgrading.");
    }
    if(namingUpgrade->Upgrading){
      if(namingUpgrade->VerifiedOutputs.size()!=namingUpgrade->Outputs.size() || namingUpgrade->ReboundSelections.size()!=namingUpgrade->Selections.size())
        throw CadError("IMPORT_NAMING_UPGRADE_REFERENCE_MISSING","Not all verified historical references were reached during the upgraded replay.");
      for(auto& feature:replayDefinitions){
        const auto references=selectionReferences.find(feature.Id);
        if(references!=selectionReferences.end())for(const auto& [key,value]:references->second)feature.StringParameters[key]=value;
      }
      namingUpgrade->Features=std::move(replayDefinitions);namingUpgrade->Coordinates=myCoordinateSystems;
      for(const auto& [id,coordinate]:replayCoordinates.Records())if(coordinate.AssociationMode=="associative" && coordinate.ReferenceState=="resolved"){
        auto retained=namingUpgrade->Coordinates.Records().at(id);retained.ReferenceSelector=coordinate.ReferenceSelector;namingUpgrade->Coordinates.Set(retained);
      }
    }
    return "{}"; // Internal proof pass only: no revision, metadata or geometry commit.
  }
  if (!lifecycleReplay && !dynamicBodyReplay)
  {
    if (replayBodies.size() != myBodies.size())
      throw CadError("INVALID_FEATURE_GRAPH", "Replayed body set does not match the current document.");
    for (const auto& [bodyId, unused] : myBodies)
      if (replayBodies.find(bodyId) == replayBodies.end())
        throw CadError("INVALID_FEATURE_GRAPH", "Replayed body is missing from the current document: " + bodyId);
  }

  if (lifecycleReplay)
    for (auto& [bodyId, replay] : replayBodies)
      for (auto feature = myFeatures.rbegin(); feature != myFeatures.rend(); ++feature)
      {
        const std::string key = "lifecycleBodyMeta." + bodyId + ".name";
        if (feature->StringParameters.find(key) == feature->StringParameters.end()) continue;
        applyStoredMetadata(replay, *feature, "lifecycleBodyMeta", bodyId);
        break;
      }

  // Validate and prepare recovery evidence in the replay copy. A malformed or
  // oversized proof must fail before advancing the live document or removing a
  // Body, even when this method is called outside the Worker transaction shell.
  for(auto& feature:replayDefinitions){
    const auto references=selectionReferences.find(feature.Id);
    if(references!=selectionReferences.end())
      for(const auto& [key,value]:references->second)feature.StringParameters[key]=value;
  }
  std::vector<std::string> removedBodyIds;
  std::map<std::string,std::string> capturedDefinitionDigests,restoredDefinitionDigests;
  if(lifecycleReplay || dynamicBodyReplay)
    for(const auto& [bodyId,unused]:myBodies)
      if(replayBodies.find(bodyId)==replayBodies.end())removedBodyIds.push_back(bodyId);
  for(const auto& bodyId:removedBodyIds){
    const auto& body=myBodies.at(bodyId);
    const auto owner=std::find_if(replayDefinitions.rbegin(),replayDefinitions.rend(),[&](const FeatureNode& feature){
      return feature.State=="suppressed" && std::find(feature.OutputBodies.begin(),feature.OutputBodies.end(),bodyId)!=feature.OutputBodies.end();
    });
    const auto source=std::find_if(replayDefinitions.begin(),replayDefinitions.end(),[&](const FeatureNode& feature){return feature.Id==body.SourceFeatureId;});
    const auto original=std::find_if(myFeatures.begin(),myFeatures.end(),[&](const FeatureNode& feature){return feature.Id==body.SourceFeatureId;});
    const auto identity=myEntityIdentities.find(bodyId);
    if(owner!=replayDefinitions.rend() && source!=replayDefinitions.end() && original!=myFeatures.end() && identity!=myEntityIdentities.end()){
      if(source->Identity.empty())source->Identity=newIdentity();
      auto& definitionDigest=capturedDefinitionDigests[source->Id];
      if(definitionDigest.empty())definitionDigest=StableSuspendedDefinitionFingerprint(*original,source->Identity);
      owner->SuspendedTopology[bodyId]=CaptureSuspendedTopology(body.Shape,body.Names,
        {bodyId,identity->second.Body,identity->second.Topology,source->Id,source->Identity,body.TopologyRevision,definitionDigest,2});
    }
  }
  std::map<std::string,SuspendedTopologyResolution> recoveries;
  for(const auto& [bodyId,replay]:replayBodies){
    if(myBodies.find(bodyId)!=myBodies.end())continue;
    const auto source=std::find_if(replayDefinitions.begin(),replayDefinitions.end(),[&](const FeatureNode& feature){return feature.Id==replay.SourceFeatureId;});
    const auto identity=myEntityIdentities.find(bodyId);
    if(source==replayDefinitions.end() || identity==myEntityIdentities.end())continue;
    auto& definitionDigest=restoredDefinitionDigests[source->Id];
    if(definitionDigest.empty())definitionDigest=SuspendedDefinitionFingerprint(*source);
    for(const auto& owner:replayDefinitions){
      const auto proof=owner.SuspendedTopology.find(bodyId);
      if(owner.State=="suppressed" || proof==owner.SuspendedTopology.end()
         || std::find(owner.OutputBodies.begin(),owner.OutputBodies.end(),bodyId)==owner.OutputBodies.end())continue;
      const auto resolved=ResolveSuspendedTopology(replay.Shape,replay.Names,proof->second,
        {bodyId,identity->second.Body,"",source->Id,source->Identity,0,definitionDigest,1,StableSuspendedDefinitionFingerprint(*source)},myRevision+1);
      if(resolved.Verified && !recoveries.emplace(bodyId,resolved).second)
        throw CadError("INVALID_SUSPENDED_TOPOLOGY","Multiple recovery owners claim the same restored Body.");
    }
  }

  ++myRevision;
  myCoordinateSystems=std::move(replayCoordinates);
  myFeatures = std::move(replayDefinitions);
  FeatureNode& committedFeature = myFeatures.at(editedIndex);
  for (FeatureNode& feature : myFeatures)
  {
    if (affectedFeatures.find(feature.Id) == affectedFeatures.end()) continue;
    feature.ComputedRevision = myRevision;
    if (feature.State != "suppressed") feature.State = "valid";
  }

  std::map<std::string,NamedTopologyBody> beforeNames,afterNames;
  for(const auto& [id,body]:myBodies)beforeNames.emplace(id,NamedTopologyBody{body.Shape,body.Names,body.TopologyRevision,body.SourceFeatureId});
  for(const auto& [id,replay]:replayBodies){const auto old=myBodies.find(id);const int revision=replay.Affected || old==myBodies.end()?myRevision:old->second.TopologyRevision;afterNames.emplace(id,NamedTopologyBody{replay.Shape,replay.Names,revision,replay.SourceFeatureId});}
  const auto semanticBodies=TopologyNaming::MatchBodies(beforeNames,afterNames);
  for (const std::string& bodyId : removedBodyIds)
  {
    const auto found = myBodies.find(bodyId);
    myProperties.OrphanBody(bodyId, "feature lifecycle removed the current Body");
    myShapeTool->RemoveShape(found->second.Label, true);
    myBodies.erase(found);
  }

  std::string resultBodyId;
  for (auto& [bodyId, replay] : replayBodies)
  {
    auto existing = myBodies.find(bodyId);
    if (existing == myBodies.end())
    {
      BodyRecord restored;
      restored.Id = bodyId;
      restored.SourceFeatureId = replay.SourceFeatureId;
      restored.Shape = replay.Shape;
      restored.Names = replay.Names;
      restored.Kind = BodyKindFromShape(replay.Shape);
      restored.Label = myShapeTool->AddShape(restored.Shape, false, false);
      restored.TopologyRevision = myRevision;
      restored.Name = replay.HasMetadata ? replay.Name : bodyId;
      restored.Visible = replay.HasMetadata ? replay.Visible : true;
      restored.Color = replay.HasMetadata ? replay.Color : "#7b91aa";
      restored.Material = replay.HasMetadata ? replay.Material : "";
      restored.Opacity = replay.HasMetadata ? replay.Opacity : 1.0;
      myBodies.emplace(bodyId, std::move(restored));
      myProperties.ReactivateBodyProperties(bodyId, "feature lifecycle restored the Body");
      const auto recoveryEntry=recoveries.find(bodyId);
      if(recoveryEntry!=recoveries.end()){
        const auto& recovery=recoveryEntry->second;
        myProperties.RemapTopology(bodyId,bodyId,recovery.Mapping,"feature lifecycle: verified topology restoration",true);
        for(const auto& [oldId,targets]:recovery.Mapping){
          TopologyLineageEntry entry;entry.SourceBodyId=bodyId;entry.SourceTopologyId=oldId;
          entry.SourceBodyIdentity=recovery.Source.BodyIdentity;entry.SourceTopologyIdentity=recovery.Source.TopologyIdentity;
          entry.SourceRevision=recovery.Source.Revision;entry.ResultRevision=myRevision;entry.State=targets.empty()?"unresolved":"mapped";
          for(const auto& target:targets)entry.Destinations.push_back({bodyId,target});
          committedFeature.TopologyEvolutions.push_back(std::move(entry));
        }
      }
      if (replay.Affected && resultBodyId.empty()) resultBodyId = bodyId;
      continue;
    }

    BodyRecord& body = existing->second;
    if (replay.Affected)
    {
      ShapeSerializer oldTopology(body.Shape, body.TopologyRevision, body.Id);
      ShapeSerializer newTopology(replay.Shape, myRevision, body.Id);
      const auto& semantic=semanticBodies.at(body.Id);
      if(!body.Names.empty() && !replay.Names.empty())
        myProperties.RemapTopologyToBodies(body.Id,semantic,false,"feature.update: semantic topology identity");
      else if (replay.ComplexTopology)
        myProperties.OrphanTopology(body.Id, "feature.update: complex topology requires reassignment");
      else
        myProperties.RemapTopology(body.Id, body.Id,
                                   TopologyHistory::MapByIndex(oldTopology, newTopology,
                                                               body.TopologyRevision, myRevision),
                                   "feature.update");
      std::map<std::string,TopologyLineageEntry> evolution;
      for(const auto& [destination,mapping]:semantic)for(const auto& [source,targets]:mapping) {
        auto& entry=evolution[source];entry.SourceBodyId=body.Id;entry.SourceTopologyId=source;entry.SourceRevision=body.TopologyRevision;entry.ResultRevision=myRevision;
        for(const auto& target:targets)entry.Destinations.push_back({destination,target});
      }
      for(auto& [unused,entry]:evolution){entry.State=entry.Destinations.empty()?"unresolved":"mapped";committedFeature.TopologyEvolutions.push_back(std::move(entry));}
      body.Shape = replay.Shape;
      body.Names = replay.Names;
      body.Kind = BodyKindFromShape(replay.Shape);
      body.SourceFeatureId = replay.SourceFeatureId;
      body.TopologyRevision = myRevision;
      myShapeTool->SetShape(body.Label, body.Shape);
      if (resultBodyId.empty()) resultBodyId = body.Id;
    }
    if (lifecycleReplay && replay.HasMetadata)
    {
      body.Name = replay.Name;
      body.Visible = replay.Visible;
      body.Color = replay.Color;
      body.Material = replay.Material;
      body.Opacity = replay.Opacity;
    }
  }
  if (resultBodyId.empty() && !replayBodies.empty()) resultBodyId = replayBodies.begin()->first;
  myActiveBodyId = resultBodyId;
  persistMetadata();
  if (resultBodyId.empty()) return Summary(requestId);
  const BodyRecord& result = myBodies.at(resultBodyId);
  return ShapeSerializer(result.Shape, result.TopologyRevision, result.Id).Serialize(responsePrefix(requestId));
}

std::string CadDocument::ChangeFeatureLifecycle(const std::string& requestId,
                                                const int expectedRevision,
                                                const std::string& featureId,
                                               const std::string& action,
                                               const JsonValue& parameters, const HistoricalInputTarget& inspectionTarget)
{
  if (expectedRevision != myRevision)
    throw CadError("STALE_REVISION", "Document revision is stale. Reload before changing the feature.");
  const auto feature = std::find_if(myFeatures.begin(), myFeatures.end(),
    [&](const FeatureNode& candidate) { return candidate.Id == featureId; });
  if (feature == myFeatures.end()) throw CadError("FEATURE_NOT_FOUND", "Feature does not exist.");

  const bool unary = (feature->Type.rfind("transform.", 0) == 0 && feature->Type != "transform.copy")
    || feature->Type == "detail.fillet" || feature->Type == "detail.chamfer"
    || feature->Type == "detail.shell" || feature->Type == "detail.offset" || feature->Type == "detail.draft";
  const bool bodyCreatingFeature = feature->Type == "detail.thicken" || feature->Type == "detail.revolve" || feature->Type == "detail.sweep" || feature->Type == "detail.pipe" || feature->Type == "detail.loft" || feature->Type == "pattern.linear" || feature->Type == "pattern.circular" || feature->Type == "pattern.rectangular" || feature->Type == "pattern.mirror";
  const bool booleanFeature = isBooleanType(feature->Type);
  if ((!unary && !bodyCreatingFeature && !booleanFeature)
      || ((unary || bodyCreatingFeature)
          && (feature->OutputBodies.empty() || (feature->Type == "detail.loft" ? feature->InputFeatures.size() < (IsProfileLoft(*feature)?1u:2u) : ((feature->Type=="detail.sweep" || feature->Type=="detail.pipe") && IsCurveSweep(*feature))?feature->InputFeatures.empty():feature->InputFeatures.size() != 1))))
    throw CadError("FEATURE_LIFECYCLE_UNSUPPORTED",
                   "This feature does not support suppress, restore and delete.");

  JsonValue replay = JsonValue::MakeObject();
  replay.ChangeObject().emplace("__lifecycleReplay", JsonValue(true));
  if (const auto* edits = parameters.Find("selectionEdits")) replay.ChangeObject()["selectionEdits"] = *edits;
  if (const auto* edits = parameters.Find("coordinateSelectionEdits")) replay.ChangeObject()["coordinateSelectionEdits"] = *edits;

  if (action == "feature.suppress" || action == "feature.restore")
  {
    const std::string nextState = action == "feature.suppress" ? "suppressed" : "valid";
    if (feature->State == nextState && inspectionTarget.empty() && !parameters.Has("selectionEdits") && !parameters.Has("coordinateSelectionEdits")) return View(requestId);
    const std::vector<FeatureNode> previousFeatures = myFeatures;
    if (booleanFeature || bodyCreatingFeature)
    {
      const auto captureMetadata = [&](const std::string& role, const std::vector<std::string>& bodyIds)
      {
        for (const std::string& bodyId : bodyIds)
        {
          const auto body = myBodies.find(bodyId);
          if (body == myBodies.end()) continue;
          StoreBodyDisplayMetadata(*feature,role,body->second);
        }
      };
      if (action == "feature.suppress")
      {
        captureMetadata("outputBodyMeta", feature->OutputBodies);
      }
      else if (booleanFeature)
      {
        std::vector<std::string> inputs = storedBodyIds(*feature, "targetBodies", "targetBody");
        const std::vector<std::string> tools = storedBodyIds(*feature, "toolBodies", "toolBody");
        inputs.insert(inputs.end(), tools.begin(), tools.end());
        captureMetadata("inputBodyMeta", inputs);
      }
    }
    feature->State = nextState;
    try
    {
      return replayFeatureEdit(requestId, expectedRevision, featureId, replay, inspectionTarget);
    }
    catch (...)
    {
      myFeatures = previousFeatures;
      throw;
    }
  }

  if (action != "feature.delete")
    throw CadError("INVALID_FEATURE_ACTION", "Unknown feature lifecycle action: " + action);

  const std::string predecessorId = feature->InputFeatures.front();
  const std::vector<FeatureNode> backup = myFeatures;
  if (booleanFeature)
  {
    std::vector<std::string> inputBodyIds = storedBodyIds(*feature, "targetBodies", "targetBody");
    const std::vector<std::string> toolBodyIds = storedBodyIds(*feature, "toolBodies", "toolBody");
    inputBodyIds.insert(inputBodyIds.end(), toolBodyIds.begin(), toolBodyIds.end());
    if (inputBodyIds.size() != feature->InputFeatures.size())
      throw CadError("INVALID_FEATURE_GRAPH", "Boolean input Bodies do not match input Features.");
    for (std::size_t index = 0; index < inputBodyIds.size(); ++index)
    {
      const std::string& bodyId = inputBodyIds[index];
      const auto producer = std::find_if(myFeatures.begin(), myFeatures.end(),
        [&](const FeatureNode& candidate) { return candidate.Id == feature->InputFeatures[index]; });
      if (producer == myFeatures.end())
        throw CadError("INVALID_FEATURE_GRAPH", "Boolean input producer is unavailable during deletion.");
      for (const std::string& suffix : {"name", "visible", "color", "material", "opacity"})
      {
        const std::string sourceKey = "inputBodyMeta." + bodyId + "." + suffix;
        const auto value = feature->StringParameters.find(sourceKey);
        if (value != feature->StringParameters.end())
          producer->StringParameters["lifecycleBodyMeta." + bodyId + "." + suffix] = value->second;
      }
    }
  }
  myFeatures.erase(feature);
  for (FeatureNode& candidate : myFeatures)
    for (std::string& input : candidate.InputFeatures)
      if (input == featureId) input = predecessorId;
  try
  {
    return replayFeatureEdit(requestId, expectedRevision, predecessorId, replay, inspectionTarget);
  }
  catch (...)
  {
    myFeatures = backup;
    throw;
  }
}
std::string CadDocument::Preview(const std::string& requestId, const int offset, const int limit) const
{
  const int previewOffset = offset > 0 ? offset : 0;
  const int previewLimit = limit > 0 ? limit : static_cast<int>(myBodies.size());
  std::ostringstream presentations;
  presentations << '[';
  bool first = true;
  int bodyIndex = 0;
  int emitted = 0;
  ShapeSerializationLimits limits;
  limits.linearDeflection = 0.6;
  limits.angularDeflection = 0.3;
  limits.maxTriangles = 2000;
  limits.maxEdges = 1;
  limits.edgeSamples = 2;
  for (const auto& [id, body] : myBodies)
  {
    if (bodyIndex++ < previewOffset) continue;
    if (emitted >= previewLimit) break;
    if (!first) presentations << ',';
    presentations << ShapeSerializer(body.Shape, body.TopologyRevision, body.Id, limits).SerializeBody();
    first = false;
    ++emitted;
  }
  presentations << ']';
  return responsePrefix(requestId) + ",\"bodyPresentations\":" + presentations.str()
       + ",\"presentationMode\":\"preview\",\"previewOffset\":" + std::to_string(previewOffset)
       + ",\"previewCount\":" + std::to_string(emitted)
       + ",\"previewTotal\":" + std::to_string(myBodies.size()) + '}';
}

std::string CadDocument::View(const std::string& requestId, const bool includePresentations) const
{
  if (myBodies.empty()) return Summary(requestId);
  // Large assemblies are served through BodyPresentation() so one worker
  // response never contains every body's mesh.
  if (!includePresentations || myBodies.size() > 8) return Summary(requestId);

  std::string activePresentation;
  std::ostringstream presentations;
  presentations << '[';
  bool first = true;
  for (const auto& [id, body] : myBodies)
  {
    const std::string presentation = ShapeSerializer(body.Shape, body.TopologyRevision, body.Id).SerializeBody();
    if (id == myActiveBodyId) activePresentation = presentation;
    if (!first) presentations << ',';
    presentations << presentation;
    first = false;
  }
  presentations << ']';
  if (activePresentation.empty())
    throw CadError("BODY_NOT_FOUND", "The active body does not exist.");

  activePresentation.pop_back();
  return responsePrefix(requestId) + ',' + activePresentation.substr(1)
       + ",\"bodyPresentations\":" + presentations.str() + '}';
}

std::string CadDocument::BodyPresentation(const std::string& requestId, const std::string& bodyId) const
{
  const BodyRecord& body = bodyOrActive(bodyId);
  return ShapeSerializer(body.Shape, body.TopologyRevision, body.Id)
    .Serialize(responsePrefix(requestId));
}
}
