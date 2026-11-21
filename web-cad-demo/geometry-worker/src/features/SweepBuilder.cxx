#include "SweepBuilder.hxx"
#include "../document/CadError.hxx"
#include "../document/ShapeFingerprint.hxx"
#include "../document/SolidOrientation.hxx"
#include "BooleanBuilder.hxx"
#include "../presentation/ShapeSerializer.hxx"
#include <BRepAdaptor_Curve.hxx>
#include <BRepAdaptor_Surface.hxx>
#include <BRepBuilderAPI_Copy.hxx>
#include <BRepBuilderAPI_MakeWire.hxx>
#include <BRepBuilderAPI_Transform.hxx>
#include <BRepBuilderAPI_MakeFace.hxx>
#include <BRepTools.hxx>
#include <TopExp_Explorer.hxx>
#include <TopoDS_Wire.hxx>
#include <BRepCheck_Analyzer.hxx>
#include <BRepGProp.hxx>
#include <BRepOffsetAPI_MakePipe.hxx>
#include <BRepTools_WireExplorer.hxx>
#include <BOPAlgo_ArgumentAnalyzer.hxx>
#include <BOPAlgo_CheckStatus.hxx>
#include <GProp_GProps.hxx>
#include <Precision.hxx>
#include <TopoDS.hxx>
#include <gp_Quaternion.hxx>
#include <gp_Trsf.hxx>
#include <gp_Pln.hxx>
#include <algorithm>
#include <cmath>
#include <set>
#include <cctype>

namespace occweb
{
namespace
{
std::string qualifiedProof(const JsonValue& reference,const std::string& topologyProof)
{
  if(topologyProof.empty())return {};
  return StableDigest(JsonSerialize(reference.At("bodyIdentity"))+JsonSerialize(reference.At("featureIdentity"))+topologyProof);
}
struct Endpoint {gp_Pnt Point;gp_Vec Tangent;};
TopoDS_Shape closedSolid(const TopoDS_Shape& shape)
{
  TopoDS_Shape solid;int count=0;for(TopExp_Explorer item(shape,TopAbs_SOLID);item.More();item.Next()){solid=item.Current();++count;}
  if(count!=1)throw CadError("INVALID_SWEEP_RESULT","The curved sweep must contain exactly one finite solid.");
  ShapeSerializer whole(shape,0,""),part(solid,0,"");
  if(whole.Faces().Extent()!=part.Faces().Extent() || whole.Edges().Extent()!=part.Edges().Extent())throw CadError("INVALID_SWEEP_RESULT","The curved sweep contains unattached topology outside its solid.");
  solid=OrientClosedSolidResult(solid);if(!BRepCheck_Analyzer(solid).IsValid())throw CadError("INVALID_SWEEP_RESULT","The curved sweep produced an invalid closed solid.");return solid;
}
Endpoint endpoint(const TopoDS_Edge& edge,bool last)
{
  BRepAdaptor_Curve curve(edge);const bool reverse=edge.Orientation()==TopAbs_REVERSED;
  const double parameter=(last!=reverse)?curve.LastParameter():curve.FirstParameter();
  Endpoint result;curve.D1(parameter,result.Point,result.Tangent);if(reverse)result.Tangent.Reverse();
  if(!std::isfinite(parameter) || result.Tangent.SquareMagnitude()<1e-20)
    throw CadError("INVALID_SWEEP_PATH","The path has an unbounded or singular endpoint tangent.");
  result.Tangent.Normalize();return result;
}
}
bool IsCurveSweep(const FeatureNode& feature)
{
  const auto version=feature.StringParameters.find("sweepVersion");
  if(version==feature.StringParameters.end())return false;
  if(version->second!="2")throw CadError("UNSUPPORTED_SWEEP_VERSION","Unsupported curved sweep definition version.");
  return true;
}
std::vector<SweepInputSlot> CurveSweepInputs(const FeatureNode& feature)
{
  if((feature.Type!="detail.sweep" && feature.Type!="detail.pipe") || !IsCurveSweep(feature))
    throw CadError("INVALID_SELECTION_REPAIR","Select an input of a real curved sweep or pipe.");
  const auto path=JsonParser(feature.StringParameters.at("sweepPath")).Parse();const auto& edges=path.At("edges").AsArray();
  if(edges.empty() || edges.size()>32)throw CadError("INVALID_SWEEP_PATH","A curved path requires 1 to 32 inputs.");
  std::vector<SweepInputSlot> slots{{"profile","sweepProfile","face",-1}};std::set<std::string> used{"profile"};
  for(std::size_t index=0;index<edges.size();++index){
    // Old v2 files predate explicit slot IDs. Their deterministic legacy keys
    // remain scoped to the frozen feature definition; newly replaced paths
    // allocate fresh UUID keys, including on a new branch after Undo.
    const auto id=edges[index].GetStringOr("inputId","legacy-path-"+std::to_string(index+1));
    if(id.empty() || id.size()>96 || !std::all_of(id.begin(),id.end(),[](unsigned char ch){return std::isalnum(ch)||ch=='-'||ch=='_';}) || !used.insert(id).second)
      throw CadError("INVALID_SWEEP_REFERENCE","Curved path input IDs must be unique identifiers.");
    slots.push_back({id,"sweepPath","edge",static_cast<int>(index)});
  }
  return slots;
}
void StoreCurveSweepReference(FeatureNode& feature,const std::string& field,const JsonValue& reference)
{
  feature.StringParameters[field]=JsonSerialize(reference);feature.InputFeatures.clear();
  for(const auto& key:{"sweepProfile","sweepPath"}){
    const auto source=JsonParser(feature.StringParameters.at(key)).Parse().GetString("featureId");
    if(std::find(feature.InputFeatures.begin(),feature.InputFeatures.end(),source)==feature.InputFeatures.end())feature.InputFeatures.push_back(source);
  }
  feature.StringParameters["sourceBody"]=JsonParser(feature.StringParameters.at("sweepProfile")).Parse().GetString("bodyId");
}
CadError CurveSweepInputFailure(const std::string& featureId,const std::string& inputId,const std::string& kind,const std::string& reason)
{
  auto details=JsonValue::MakeObject();auto& fields=details.ChangeObject();fields["featureId"]=JsonValue(featureId);fields["sweepInputId"]=JsonValue(inputId);fields["selectionKind"]=JsonValue(kind);
  return CadError("SWEEP_INPUT_UNRESOLVED",reason,JsonSerialize(details));
}
SweepProfile ResolveSweepProfile(const TopoDS_Shape& shape,const TopologyNames& names,const JsonValue& reference)
{
  const auto selector=reference.GetString("selector");
  if(JsonParser(selector).Parse().GetString("kind")!="face")throw CadError("INVALID_SWEEP_REFERENCE","A sweep profile must reference a Face, not another topology kind.");
  const int index=TopologyNaming::ResolveSelection(shape,names,selector);ShapeSerializer topology(shape,0,"");
  SweepProfile result{TopoDS::Face(topology.Faces()(index)),{},qualifiedProof(reference,TopologyNaming::SelectionProof(shape,names,"face",index))};
  if(BRepAdaptor_Surface(result.Face).GetType()!=GeomAbs_Plane)
    throw CadError("SWEEP_PROFILE_NOT_PLANAR","Select an actual planar Face as the sweep profile.");
  result.Names=TopologyNaming::Restrict(shape,names,result.Face);return result;
}
SweepPath ResolveSweepPath(const TopoDS_Shape& shape,const TopologyNames& names,const JsonValue& reference,const std::string& featureId)
{
  const auto& edges=reference.At("edges").AsArray();
  if(edges.empty() || edges.size()>32)throw CadError("INVALID_SWEEP_PATH","Select 1 to 32 ordered path Edges from one source Body.");
  ShapeSerializer topology(shape,0,"");SweepPath result;std::string proof;bool proven=true;
  std::size_t slot=0;for(const auto& edge:edges){
    const auto inputId=edge.GetStringOr("inputId","legacy-path-"+std::to_string(++slot));
    const auto selector=edge.GetString("selector");
    if(JsonParser(selector).Parse().GetString("kind")!="edge")throw CadError("INVALID_SWEEP_REFERENCE","A sweep path must reference Edges.");
    int index=0;try{index=TopologyNaming::ResolveSelection(shape,names,selector);}catch(const CadError& error){if(!featureId.empty() && (error.Code()=="FEATURE_SELECTION_UNRESOLVED" || error.Code()=="FEATURE_SELECTION_UNVERIFIED"))throw CurveSweepInputFailure(featureId,inputId,"edge",error.what());throw;}
    auto selected=TopoDS::Edge(topology.Edges()(index));
    const auto direction=edge.GetString("orientation");
    if(direction!="forward" && direction!="reversed")throw CadError("INVALID_SWEEP_REFERENCE","Invalid stored Edge direction.");
    selected.Orientation(direction=="reversed"?TopAbs_REVERSED:TopAbs_FORWARD);
    for(const auto& previous:result.Edges)if(previous.IsSame(selected))throw CadError("INVALID_SWEEP_PATH","The same path Edge cannot be listed twice.");
    result.Edges.push_back(selected);
    const auto role=qualifiedProof(reference,TopologyNaming::SelectionProof(shape,names,"edge",index));
    if(role.empty())proven=false;proof+=std::to_string(role.size())+':'+role+'/'+direction;
  }
  if(proven)result.Proof=StableDigest(proof);return result;
}
CurveSweepResult BuildCurveSweep(const SweepProfile& source,const SweepPath& path,const FeatureNode& feature)
{
  if(path.Edges.empty() || path.Edges.size()>32)throw CadError("INVALID_SWEEP_PATH","A bounded, non-empty path is required.");
  const auto placement=feature.StringParameters.at("sweepPlacement"),frame=feature.StringParameters.at("sweepFrame");
  if(placement!="actual" && placement!="align-start")throw CadError("INVALID_PARAMETER","Sweep placement must be actual or align-start.");
  if(frame!="corrected-frenet" && frame!="frenet")throw CadError("INVALID_PARAMETER","Unsupported sweep frame.");
  BRepBuilderAPI_MakeWire wireBuilder;
  std::vector<TopoDS_Edge> copies;for(const auto& edge:path.Edges){BRepBuilderAPI_Copy copy(edge,true,false);copies.push_back(TopoDS::Edge(copy.Shape()));}
  if(copies.size()>1){
    const auto a=endpoint(copies[0],false),b=endpoint(copies[0],true),c=endpoint(copies[1],false),d=endpoint(copies[1],true);
    if(b.Point.Distance(c.Point)>Precision::Confusion() && b.Point.Distance(d.Point)>Precision::Confusion()
       && (a.Point.Distance(c.Point)<=Precision::Confusion() || a.Point.Distance(d.Point)<=Precision::Confusion()))copies[0].Reverse();
  }
  for(std::size_t i=0;i<copies.size();++i){
    if(copies.size()>1 && endpoint(copies[i],false).Point.Distance(endpoint(copies[i],true).Point)<=Precision::Confusion())throw CadError("SWEEP_PATH_BRANCHED","A closed Edge cannot be combined with additional path branches.");
    if(i){const auto end=endpoint(copies[i-1],true).Point;
      if(end.Distance(endpoint(copies[i],false).Point)>Precision::Confusion()){
        if(end.Distance(endpoint(copies[i],true).Point)<=Precision::Confusion())copies[i].Reverse();
        else throw CadError("SWEEP_PATH_DISCONNECTED","Path Edges must connect in the listed order; no reordering or gap healing was applied.");
      }
    }
    wireBuilder.Add(copies[i]);if(!wireBuilder.IsDone())throw CadError("SWEEP_PATH_DISCONNECTED","Ordered path Edges do not form one connected wire; no gap healing was applied.");
  }
  auto wire=wireBuilder.Wire();if(feature.StringParameters.at("sweepReverse")=="true")wire.Reverse();
  std::vector<TopoDS_Edge> ordered;for(BRepTools_WireExplorer explorer(wire);explorer.More();explorer.Next())ordered.push_back(explorer.Current());
  if(ordered.size()!=path.Edges.size())throw CadError("SWEEP_PATH_BRANCHED","The selected path is branched or does not traverse every selected Edge exactly once.");
  const auto start=endpoint(ordered.front(),false);auto previous=endpoint(ordered.front(),true);
  for(std::size_t i=1;i<ordered.size();++i){const auto next=endpoint(ordered[i],false);if(previous.Point.Distance(next.Point)>Precision::Confusion() || previous.Tangent.Angle(next.Tangent)>1e-6)throw CadError("SWEEP_PATH_NOT_G1","The path must be tangent-continuous (G1). Sharp-corner transitions are not silently approximated.");previous=endpoint(ordered[i],true);}
  if(wire.Closed() && (previous.Point.Distance(start.Point)>Precision::Confusion() || previous.Tangent.Angle(start.Tangent)>1e-6))throw CadError("SWEEP_PATH_NOT_G1","A closed path must also be tangent-continuous at its seam.");
  BRepBuilderAPI_Copy profileCopy(source.Face,true,false);TopoDS_Shape profile=profileCopy.Shape();
  auto names=TopologyNaming::Propagate(source.Face,source.Names,profile,profileCopy);
  const auto plane=BRepAdaptor_Surface(TopoDS::Face(profile)).Plane();gp_Vec normal(plane.Axis().Direction());if(source.Face.Orientation()==TopAbs_REVERSED)normal.Reverse();
  if(placement=="align-start"){
    GProp_GProps properties;BRepGProp::SurfaceProperties(profile,properties);if(properties.Mass()<=Precision::Confusion()*Precision::Confusion())throw CadError("INVALID_SWEEP_PROFILE","The selected profile has no finite positive area.");
    gp_Trsf transform;transform.SetRotation(gp_Quaternion(normal,start.Tangent));const auto rotated=properties.CentreOfMass().Transformed(transform);transform.SetTranslationPart(gp_Vec(rotated,start.Point));
    BRepBuilderAPI_Transform moved(profile,transform,true);names=TopologyNaming::Propagate(profile,names,moved.Shape(),moved);profile=moved.Shape();
  }else if(plane.Distance(start.Point)>Precision::Confusion() || std::abs(normal.Normalized().Dot(start.Tangent))<1-1e-7)
    throw CadError("SWEEP_PROFILE_PLACEMENT","The profile plane must contain the path start and be perpendicular to its tangent. Select align-start to explicitly transform a profile copy.");
  std::vector<TopoDS_Wire> boundaries;for(TopExp_Explorer item(profile,TopAbs_WIRE);item.More();item.Next())boundaries.push_back(TopoDS::Wire(item.Current()));
  if(boundaries.size()>1){
    if(boundaries.size()>33)throw CadError("SWEEP_PROFILE_LIMIT","Curved sweep profiles support at most 32 holes.");
    // Align the complete section ONCE. Centering each filled hole separately
    // would silently move eccentric holes onto the path axis.
    const auto outer=BRepTools::OuterWire(TopoDS::Face(profile));CurveSweepResult exterior;std::vector<CurveSweepResult> holes;
    ShapeSerializer original(profile,0,"");FeatureNode componentFeature;componentFeature.Id=feature.Id+"/placed-"+placement;componentFeature.StringParameters=feature.StringParameters;componentFeature.StringParameters["sweepPlacement"]="actual";
    for(const auto& boundary:boundaries){
      BRepBuilderAPI_MakeFace filled(boundary,true);if(!filled.IsDone())throw CadError("INVALID_SWEEP_PROFILE","A planar boundary could not form a finite sweep section.");
      auto componentNames=TopologyNaming::Restrict(profile,names,filled.Face());std::vector<std::string> origins;
      for(TopExp_Explorer edge(boundary,TopAbs_EDGE);edge.More();edge.Next()){const auto id="edge:"+std::to_string(original.Edges().FindIndex(edge.Current()));const auto found=names.find(id);if(found!=names.end())origins.insert(origins.end(),found->second.begin(),found->second.end());}
      std::sort(origins.begin(),origins.end());origins.erase(std::unique(origins.begin(),origins.end()),origins.end());
      auto originJson=JsonValue::MakeArray();for(const auto& value:origins)originJson.ChangeArray().emplace_back(value);
      const auto boundaryProof=source.Proof.empty()||origins.empty()?std::string():StableDigest(source.Proof+(boundary.IsSame(outer)?"outer":"hole")+JsonSerialize(originJson));
      if(!boundaryProof.empty()){componentNames["face:1"]={"curve-profile/"+boundaryProof};TopologyNaming::CompleteEdges(filled.Face(),componentNames);}
      const auto component=BuildCurveSweep({filled.Face(),componentNames,boundaryProof},path,componentFeature);
      if(boundary.IsSame(outer))exterior=component;else holes.push_back(component);
    }
    if(exterior.Shape.IsNull())throw CadError("INVALID_SWEEP_PROFILE","A planar profile has no outer boundary.");
    std::vector<TopoDS_Shape> tools;for(const auto& hole:holes)tools.push_back(hole.Shape);
    const auto cut=BuildBooleanOperation("boolean.cut",{exterior.Shape},tools,true);
    CurveSweepResult result{closedSolid(cut.Shape),{}};
    result.Names=TopologyNaming::Propagate(exterior.Shape,exterior.Names,result.Shape,*cut.History);
    for(const auto& hole:holes)TopologyNaming::Merge(result.Names,TopologyNaming::Propagate(hole.Shape,hole.Names,result.Shape,*cut.History));
    TopologyNaming::CompleteEdges(result.Shape,result.Names);return result;
  }
  BRepOffsetAPI_MakePipe builder(wire,profile,frame=="frenet"?GeomFill_IsFrenet:GeomFill_IsCorrectedFrenet,false);builder.Build();
  if(!builder.IsDone())throw CadError("SWEEP_BUILD_FAILED","OCCT could not construct the real curved sweep.");
  const auto result=closedSolid(builder.Shape());
  for(TopExp_Explorer face(result,TopAbs_FACE);face.More();face.Next()){
    BRepAdaptor_Surface surface(TopoDS::Face(face.Current()));
    if(surface.GetType()==GeomAbs_Torus && surface.Torus().MinorRadius()>=surface.Torus().MajorRadius()-Precision::Confusion())
      throw CadError("SWEEP_SELF_INTERSECTION","The swept section crosses the circular path's curvature center and forms a singular/self-overlapping torus.");
  }
  BOPAlgo_ArgumentAnalyzer check;check.SetShape1(result);check.StopOnFirstFaulty()=false;check.ArgumentTypeMode()=false;check.SelfInterMode()=true;check.SmallEdgeMode()=false;check.RebuildFaceMode()=false;check.TangentMode()=false;check.MergeVertexMode()=false;check.MergeEdgeMode()=false;check.ContinuityMode()=false;check.CurveOnSurfaceMode()=false;check.Perform();
  if(check.HasErrors())throw CadError("SWEEP_CHECK_FAILED","OCCT could not complete the curved sweep self-intersection check.");
  for(const auto& item:check.GetCheckResult())if(item.GetCheckStatus()==BOPAlgo_SelfIntersect)throw CadError("SWEEP_SELF_INTERSECTION","The profile intersects itself along this path; reduce its size or change the path.");
  CurveSweepResult built{result,{}};
  if(!source.Proof.empty() && !path.Proof.empty()){
    const auto context=feature.Id+"/curve-sweep/"+StableDigest(source.Proof+path.Proof+placement+frame+feature.StringParameters.at("sweepReverse"));
    built.Names=TopologyNaming::SweepResult(profile,names,result,builder,context,builder.FirstShape(),builder.LastShape());
  }
  return built;
}
}
