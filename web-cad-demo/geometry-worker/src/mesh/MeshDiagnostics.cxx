#include "MeshDiagnostics.hxx"
#include "MeshPreparation.hxx"
#include "../document/CadError.hxx"
#include "../document/ShapeSpatial.hxx"
#include <BRepCheck_Analyzer.hxx>
#include <BRepCheck_Result.hxx>
#include <BRepGProp.hxx>
#include <BRepBndLib.hxx>
#include <BRep_Tool.hxx>
#include <BOPAlgo_ArgumentAnalyzer.hxx>
#include <Bnd_Box.hxx>
#include <GProp_GProps.hxx>
#include <NCollection_IndexedMap.hxx>
#include <NCollection_IndexedDataMap.hxx>
#include <NCollection_List.hxx>
#include <TopTools_ShapeMapHasher.hxx>
#include <TopExp.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Edge.hxx>
#include <TopoDS_Face.hxx>
#include <Precision.hxx>
#include <Standard_Failure.hxx>
#include <Standard_OutOfMemory.hxx>
#include <algorithm>
#include <cmath>
#include <map>
#include <set>
#include <tuple>

namespace occweb
{
namespace
{
using ShapeMap = NCollection_IndexedMap<TopoDS_Shape, TopTools_ShapeMapHasher>;
using ShapeAncestors = NCollection_IndexedDataMap<TopoDS_Shape, NCollection_List<TopoDS_Shape>, TopTools_ShapeMapHasher>;
JsonValue number(double value) { return std::isfinite(value) ? JsonValue(value) : JsonValue(); }
JsonValue text(const char* value) { return JsonValue(std::string(value)); }
JsonValue point(double x, double y, double z)
{
  auto result = JsonValue::MakeArray();
  for (double value : {x, y, z}) result.ChangeArray().push_back(number(value));
  return result;
}
JsonValue bounds(const TopoDS_Shape& shape)
{
  try
  {
    Bnd_Box box = AnalyticBounds(shape);
    if (box.IsVoid() || box.IsOpen()) return {};
    double a,b,c,d,e,f;
    box.Get(a,b,c,d,e,f);
    auto result = JsonValue::MakeObject();
    result.ChangeObject()["min"] = point(a,b,c);
    result.ChangeObject()["max"] = point(d,e,f);
    return result;
  }
  catch (const Standard_OutOfMemory&) { throw; }
  catch (const Standard_Failure&) { return {}; }
}
std::string statusName(BRepCheck_Status value)
{
  static const char* names[] = {
    "NoError","InvalidPointOnCurve","InvalidPointOnCurveOnSurface","InvalidPointOnSurface",
    "No3DCurve","Multiple3DCurve","Invalid3DCurve","NoCurveOnSurface","InvalidCurveOnSurface",
    "InvalidCurveOnClosedSurface","InvalidSameRangeFlag","InvalidSameParameterFlag","InvalidDegeneratedFlag",
    "FreeEdge","InvalidMultiConnexity","InvalidRange","EmptyWire","RedundantEdge","SelfIntersectingWire",
    "NoSurface","InvalidWire","RedundantWire","IntersectingWires","InvalidImbricationOfWires","EmptyShell",
    "RedundantFace","InvalidImbricationOfShells","UnorientableShape","NotClosed","NotConnected",
    "SubshapeNotInShape","BadOrientation","BadOrientationOfSubshape","InvalidPolygonOnTriangulation",
    "InvalidToleranceValue","EnclosedRegion","CheckFail"
  };
  const int index = static_cast<int>(value);
  return index >= 0 && index < static_cast<int>(sizeof(names)/sizeof(*names)) ? names[index] : "UnknownStatus";
}
}

JsonValue DiagnoseMeshShape(const TopoDS_Shape& shape, const MeshPreparationBody* source,
                           double tolerance, bool deepCheck)
{
  auto result = JsonValue::MakeObject();
  auto& data = result.ChangeObject();
  data["bounds"] = bounds(shape);
  double diagonal = 1.0;
  if (!data["bounds"].IsNull())
  {
    const auto& lo = data["bounds"].At("min").AsArray();
    const auto& hi = data["bounds"].At("max").AsArray();
    diagonal = std::hypot(std::hypot(hi[0].AsNumber()-lo[0].AsNumber(),hi[1].AsNumber()-lo[1].AsNumber()),hi[2].AsNumber()-lo[2].AsNumber());
  }
  const double smallThreshold = std::max(diagonal * 1e-6, tolerance * 10);
  const double toleranceThreshold = std::max(diagonal * 1e-5, Precision::Confusion() * 100);
  ShapeMap faces, edges, vertices, solids, all;
  TopExp::MapShapes(shape, TopAbs_FACE, faces);
  TopExp::MapShapes(shape, TopAbs_EDGE, edges);
  TopExp::MapShapes(shape, TopAbs_VERTEX, vertices);
  TopExp::MapShapes(shape, TopAbs_SOLID, solids);
  TopExp::MapShapes(shape, all);
  data["faceCount"] = JsonValue(double(faces.Extent()));
  data["edgeCount"] = JsonValue(double(edges.Extent()));
  data["vertexCount"] = JsonValue(double(vertices.Extent()));
  data["solidCount"] = JsonValue(double(solids.Extent()));
  data["smallFeatureThreshold"] = number(smallThreshold);
  data["highToleranceThreshold"] = number(toleranceThreshold);
  data["geometryBasis"] = text(source ? "source" : "prepared");
  auto issues = JsonValue::MakeArray();
  std::set<std::tuple<std::string,std::string,int>> unique;
  std::map<std::string,int> severities;
  const auto issue = [&](std::string code, std::string severity, const TopoDS_Shape& faulty, double value = NAN)
  {
    const int face = faces.FindIndex(faulty), edge = edges.FindIndex(faulty);
    const std::string kind = face ? "face" : edge ? "edge" : "body";
    const int index = face ? face : edge ? edge : all.FindIndex(faulty);
    if (!unique.emplace(code,kind,index).second) return;
    ++severities[severity];
    if (issues.AsArray().size() >= 128) return;
    auto entry = JsonValue::MakeObject();
    auto& item = entry.ChangeObject();
    item["code"] = JsonValue(std::move(code));
    item["severity"] = JsonValue(std::move(severity));
    item["kind"] = JsonValue(kind);
    item["index"] = JsonValue(double(index));
    item["bounds"] = bounds(faulty);
    if (std::isfinite(value)) item["value"] = number(value);
    if (source)
    {
      auto target = JsonValue::MakeObject();
      auto& fields = target.ChangeObject();
      fields["kind"] = JsonValue(kind);
      fields["bodyId"] = JsonValue(source->Id);
      fields["bodyIdentity"] = JsonValue(source->BodyIdentity);
      fields["topologyIdentity"] = JsonValue(source->TopologyIdentity);
      fields["topologyRevision"] = JsonValue(double(source->TopologyRevision));
      if (face) fields["topologyId"] = JsonValue(source->FaceIds.at(face-1));
      if (edge && source->EdgeIds.size()==static_cast<std::size_t>(edges.Extent())) fields["topologyId"] = JsonValue(source->EdgeIds.at(edge-1));
      else if(edge) fields["kind"]=text("body");
      item["target"] = target;
    }
    issues.ChangeArray().push_back(std::move(entry));
  };
  if (shape.IsNull())
  {
    data["valid"] = JsonValue(false);
    issue("NULL_SHAPE", "error", shape);
  }
  else
  {
    BRepCheck_Analyzer analyzer(shape, true, false, deepCheck);
    data["valid"] = JsonValue(analyzer.IsValid());
    for (int i=1; i<=all.Extent(); ++i)
    {
      const auto& faulty=all(i);
      if(faulty.ShapeType()<TopAbs_SOLID)continue;
      const auto& checked=analyzer.Result(faulty);
      if (checked.IsNull()) continue;
      for (auto status : checked->Status()) if (status!=BRepCheck_NoError) issue("BREP_"+statusName(status), "error", faulty);
      for (checked->InitContextIterator(); checked->MoreShapeInContext(); checked->NextShapeInContext())
        for (auto status : checked->StatusOnShape()) if (status!=BRepCheck_NoError) issue("BREP_"+statusName(status), "error", faulty);
    }
  }
  double maxTolerance=0, minEdge=INFINITY, minArea=INFINITY, volume=0;
  int smallEdges=0, smallFaces=0, sliverFaces=0, openEdges=0, nonManifold=0;
  for (int i=1;i<=vertices.Extent();++i) maxTolerance=std::max(maxTolerance,BRep_Tool::Tolerance(TopoDS::Vertex(vertices(i))));
  ShapeAncestors edgeFaces;
  TopExp::MapShapesAndUniqueAncestors(shape, TopAbs_EDGE, TopAbs_FACE, edgeFaces);
  for (int i=1;i<=edges.Extent();++i)
  {
    const auto edge=TopoDS::Edge(edges(i));
    maxTolerance=std::max(maxTolerance,BRep_Tool::Tolerance(edge));
    if (!BRep_Tool::Degenerated(edge))
    {
      try { GProp_GProps properties; BRepGProp::LinearProperties(edge,properties); const double length=properties.Mass(); minEdge=std::min(minEdge,length); if (length<=smallThreshold) {++smallEdges;issue("SMALL_EDGE","warning",edge,length);} }
      catch (const Standard_OutOfMemory&) { throw; }
      catch (const Standard_Failure&) { issue("EDGE_MEASUREMENT_FAILED","error",edge); }
    }
    if (edgeFaces.Contains(edge))
    {
      const auto& ancestors=edgeFaces.FindFromKey(edge);
      if (ancestors.Size()==1 && !BRep_Tool::Degenerated(edge) && !BRep_Tool::IsClosed(edge,TopoDS::Face(ancestors.First()))) {++openEdges;issue("OPEN_BOUNDARY",solids.IsEmpty()?"info":"warning",edge);}
      if (ancestors.Size()>2) {++nonManifold;issue("NON_MANIFOLD_EDGE","warning",edge,double(ancestors.Size()));}
    }
  }
  for (int i=1;i<=faces.Extent();++i)
  {
    maxTolerance=std::max(maxTolerance,BRep_Tool::Tolerance(TopoDS::Face(faces(i))));
    try {GProp_GProps properties;BRepGProp::SurfaceProperties(faces(i),properties);const double area=properties.Mass();minArea=std::min(minArea,area);if(area<=smallThreshold*smallThreshold){++smallFaces;issue("SMALL_FACE","warning",faces(i),area);}GProp_GProps perimeter;BRepGProp::LinearProperties(faces(i),perimeter);const double length=perimeter.Mass();const double ratio=length>0?4*3.14159265358979323846*std::abs(area)/(length*length):0;if(ratio<1e-6){++sliverFaces;issue("SLIVER_FACE","warning",faces(i),ratio);}}
    catch(const Standard_OutOfMemory&){throw;}
    catch(const Standard_Failure&){issue("FACE_MEASUREMENT_FAILED","error",faces(i));}
  }
  for (int i=1;i<=solids.Extent();++i)
  {
    GProp_GProps properties;BRepGProp::VolumeProperties(solids(i),properties);const double value=properties.Mass();volume+=value;
    if(value<=0)issue("NON_POSITIVE_VOLUME","error",solids(i),value);
  }
  if (maxTolerance>toleranceThreshold) issue("HIGH_TOLERANCE","warning",shape,maxTolerance);
  data["maxTolerance"]=number(maxTolerance);data["minimumEdgeLength"]=number(minEdge);data["minimumFaceArea"]=number(minArea);data["signedVolumeSum"]=number(volume);
  data["smallEdgeCount"]=JsonValue(double(smallEdges));data["smallFaceCount"]=JsonValue(double(smallFaces));data["sliverFaceCount"]=JsonValue(double(sliverFaces));data["openBoundaryEdgeCount"]=JsonValue(double(openEdges));data["nonManifoldEdgeCount"]=JsonValue(double(nonManifold));
  data["selfIntersectionCheck"]=text(deepCheck?"complete":"not-run");
  int selfIntersections=0;
  if (deepCheck && !shape.IsNull())
  {
    const auto analyze=[&](const TopoDS_Shape& candidate,const std::string& severity){
      BOPAlgo_ArgumentAnalyzer analyzer;
      analyzer.SetShape1(candidate);analyzer.StopOnFirstFaulty()=false;
      analyzer.ArgumentTypeMode()=false;analyzer.SelfInterMode()=true;analyzer.SmallEdgeMode()=false;analyzer.RebuildFaceMode()=false;
      analyzer.TangentMode()=false;analyzer.MergeVertexMode()=false;analyzer.MergeEdgeMode()=false;analyzer.ContinuityMode()=false;analyzer.CurveOnSurfaceMode()=false;
      try
      {
        analyzer.Perform();
        if(analyzer.HasErrors()) {data["selfIntersectionCheck"]=text("failed");issue("SELF_INTERSECTION_CHECK_FAILED","warning",candidate);}
        for(const auto& check:analyzer.GetCheckResult()) if(check.GetCheckStatus()==BOPAlgo_SelfIntersect)
        {
          ++selfIntersections;
          if(check.GetFaultyShapes1().IsEmpty())issue("SELF_INTERSECTION",severity,candidate);
          else for(const auto& faulty:check.GetFaultyShapes1())issue("SELF_INTERSECTION",severity,faulty);
        }
      }
      catch(const Standard_OutOfMemory&){throw;}
      catch(const Standard_Failure&) {data["selfIntersectionCheck"]=text("failed");issue("SELF_INTERSECTION_CHECK_FAILED","warning",candidate);}
    };
    // A Body is a container, not proof that all intersections are inter-Solid.
    // Diagnose each Solid first so later aggregate warnings cannot downgrade
    // an already identified error on the same original Face/Edge.
    if(solids.Extent()>1)for(int i=1;i<=solids.Extent();++i)analyze(solids(i),"error");
    analyze(shape,solids.Extent()==1?"error":"warning");
  }
  data["selfIntersectionCount"]=JsonValue(double(selfIntersections));
  data["issues"]=issues;
  data["issueCount"]=JsonValue(double(unique.size()));data["issuesTruncated"]=JsonValue(unique.size()>issues.AsArray().size());
  for(const auto& name:{"error","warning","info"})data[std::string(name)+"Count"]=JsonValue(double(severities[name]));
  return result;
}

MeshPreparationDiagnostics::MeshPreparationDiagnostics(std::string mode,bool deepCheck)
  :myDeepCheck(deepCheck),myTolerance(mode=="aggressive"?1e-6:1e-8),myReport(JsonValue::MakeObject())
{
  auto& data=myReport.ChangeObject();data["version"]=JsonValue(1.0);data["repairMode"]=JsonValue(std::move(mode));data["tolerance"]=number(myTolerance);data["status"]=text("preparing");data["stage"]=text("input");data["deepCheck"]=JsonValue(deepCheck);data["bodies"]=JsonValue::MakeArray();
}
void MeshPreparationDiagnostics::Before(const MeshPreparationBody& body,const TopoDS_Shape& copy)
{
  auto entry=JsonValue::MakeObject();auto& data=entry.ChangeObject();
  data["bodyId"]=JsonValue(body.Id);data["name"]=JsonValue(body.Name);data["kind"]=JsonValue(body.Kind);data["before"]=DiagnoseMeshShape(copy,&body,myTolerance,myDeepCheck);
  myReport.ChangeObject()["bodies"].ChangeArray().push_back(entry);
  myReport.ChangeObject()["stage"]=text("repair");
}
void MeshPreparationDiagnostics::After(const MeshPreparationBody& body,const TopoDS_Shape& repaired)
{
  for(auto& entry:myReport.ChangeObject()["bodies"].ChangeArray()) if(entry.GetString("bodyId")==body.Id) {entry.ChangeObject()["afterRepair"]=DiagnoseMeshShape(repaired,nullptr,myTolerance,myDeepCheck);break;}
  myReport.ChangeObject()["stage"]=text("partition");
}
void MeshPreparationDiagnostics::Complete(const TopoDS_Shape& prepared)
{
  myReport.ChangeObject()["afterPartition"]=DiagnoseMeshShape(prepared,nullptr,myTolerance,false);
  myReport.ChangeObject()["stage"]=text("partition");
  const auto& finalCheck=myReport.At("afterPartition");
  if(!finalCheck.GetBooleanOr("valid",false)||finalCheck.GetInteger("errorCount")>0)
  {
    const std::string message="Blocking geometric defects remain after conformal partitioning.";
    Failed("MESH_PARTITION_DIAGNOSTIC_FAILED",message);
    throw CadError("MESH_PARTITION_DIAGNOSTIC_FAILED",message);
  }
  myReport.ChangeObject()["status"]=text("ready");myReport.ChangeObject()["stage"]=text("complete");
}
void MeshPreparationDiagnostics::Failed(const std::string& code,const std::string& message)
{
  myReport.ChangeObject()["status"]=text("blocked");myReport.ChangeObject()["errorCode"]=JsonValue(code);myReport.ChangeObject()["error"]=JsonValue(message);
}
bool MeshPreparationDiagnostics::HasBlockingRepairErrors() const
{
  for(const auto& body:myReport.At("bodies").AsArray())
    if(body.Has("afterRepair")&&body.At("afterRepair").GetIntegerOr("errorCount",0)>0)return true;
  return false;
}
}
