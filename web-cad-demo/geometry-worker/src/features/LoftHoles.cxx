#include "LoftBuilder.hxx"
#include "../document/CadError.hxx"
#include "../document/ShapeFingerprint.hxx"
#include "../document/SolidOrientation.hxx"
#include "../presentation/ShapeSerializer.hxx"
#include <BRepAdaptor_Surface.hxx>
#include <BRepAlgoAPI_Check.hxx>
#include <BRepAlgoAPI_Cut.hxx>
#include <BRepBuilderAPI_MakeFace.hxx>
#include <BRepBuilderAPI_Transform.hxx>
#include <BRepCheck_Analyzer.hxx>
#include <BRepCheck_Wire.hxx>
#include <BRepExtrema_DistShapeShape.hxx>
#include <BRepGProp.hxx>
#include <BRepTools.hxx>
#include <BRep_Builder.hxx>
#include <GProp_GProps.hxx>
#include <Precision.hxx>
#include <TopExp_Explorer.hxx>
#include <TopExp.hxx>
#include <NCollection_IndexedMap.hxx>
#include <TopTools_ShapeMapHasher.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Compound.hxx>
#include <TopoDS_Solid.hxx>
#include <gp_Trsf.hxx>
#include <cmath>

namespace occweb
{
namespace
{
double volume(const TopoDS_Shape& shape)
{
  if(shape.IsNull())return 0;
  GProp_GProps properties;BRepGProp::VolumeProperties(shape,properties);
  const double result=properties.Mass();
  if(!std::isfinite(result))throw CadError("LOFT_HOLE_VALIDATION_FAILED","Non-finite Loft volume cannot be certified.");
  return result;
}
int wires(const TopoDS_Face& face)
{
  int count=0;for(TopExp_Explorer wire(face,TopAbs_WIRE);wire.More();wire.Next())++count;return count;
}
void validSolid(const TopoDS_Shape& shape)
{
  int solids=0;TopoDS_Shape onlySolid;for(TopExp_Explorer item(shape,TopAbs_SOLID);item.More();item.Next()){onlySolid=item.Current();++solids;}
  if(solids!=1 || !BRepCheck_Analyzer(shape).IsValid() || !BRepAlgoAPI_Check(shape,false,true).IsValid() || volume(shape)<=0)
    throw CadError("INVALID_LOFT_HOLE_RESULT","A multi-loop Loft must produce one valid positive-volume solid without detected self-interference.");
  auto oriented=TopoDS::Solid(onlySolid);
  if(!BRepLib::OrientClosedSolid(oriented))throw CadError("INVALID_LOFT_HOLE_RESULT","The Loft solid does not enclose a closed finite volume.");
  // Boolean output can be a Compound. One contained Solid does not authorize
  // silently retaining/dropping unrelated zero-volume faces, edges or points.
  for(const auto kind:{TopAbs_FACE,TopAbs_EDGE,TopAbs_VERTEX}){
    NCollection_IndexedMap<TopoDS_Shape,TopTools_ShapeMapHasher> all,contained;TopExp::MapShapes(shape,kind,all);TopExp::MapShapes(onlySolid,kind,contained);
    if(all.Extent()!=contained.Extent())throw CadError("INVALID_LOFT_HOLE_RESULT","The multi-loop Loft contains geometry outside its one closed Solid.");
  }
}
TopoDS_Face nextCap(const TopoDS_Face& before,const TopoDS_Shape& after,BRepAlgoAPI_Cut& cut)
{
  ShapeSerializer topology(after,0,"");
  if(topology.Faces().Contains(before))return before;
  TopoDS_Face result;int found=0;
  for(const auto& face:cut.Modified(before))if(face.ShapeType()==TopAbs_FACE && topology.Faces().Contains(face)){result=TopoDS::Face(face);++found;}
  if(found!=1)throw CadError("LOFT_HOLE_CAP_SPLIT","A hole split or removed an end cap; this correspondence is not a through-hole Loft.");
  return result;
}
void validateProfile(const LoftProfile& profile,std::size_t count)
{
  if(profile.Face.IsNull() || !BRepCheck_Analyzer(profile.Face).IsValid() || BRepAdaptor_Surface(profile.Face).GetType()!=GeomAbs_Plane)
    throw CadError("INVALID_LOFT_PROFILE","A multi-loop Loft requires valid planar Face sections.");
  if(profile.Holes.size()!=count || profile.HoleProofs.size()!=count || wires(profile.Face)!=static_cast<int>(count+1))
    throw CadError("LOFT_HOLE_MAPPING_REQUIRED","Every section must explicitly map the same number of inner loops; no hole may be dropped or guessed by proximity.");
  const auto outer=BRepTools::OuterWire(profile.Face);
  for(std::size_t index=0;index<count;++index){
    const auto& hole=profile.Holes[index];bool found=false;
    for(TopExp_Explorer wire(profile.Face,TopAbs_WIRE);wire.More();wire.Next())if(wire.Current().IsSame(hole))found=true;
    if(!found || hole.IsSame(outer) || BRepCheck_Wire(hole).Closed()!=BRepCheck_NoError)
      throw CadError("INVALID_LOFT_HOLE_MAPPING","An inner-loop correspondence must reference a closed inner wire of its exact selected Face.");
    for(std::size_t previous=0;previous<index;++previous)if(profile.Holes[previous].IsSame(hole))
      throw CadError("INVALID_LOFT_HOLE_MAPPING","The same inner boundary cannot occupy multiple hole slots.");
  }
}
LoftProfile loopProfile(const LoftProfile& original,const TopoDS_Wire& wire,const std::string& proof)
{
  BRepBuilderAPI_MakeFace face(BRepAdaptor_Surface(original.Face).Plane(),wire,true);
  if(!face.IsDone() || !BRepCheck_Analyzer(face.Face()).IsValid())throw CadError("INVALID_LOFT_HOLE_MAPPING","An inner boundary could not form a valid planar loop profile.");
  LoftProfile result;result.Face=face.Face();result.Proof=proof;
  ShapeSerializer source(original.Face,0,""),target(result.Face,0,"");
  for(int index=1;index<=target.Edges().Extent();++index){
    const auto found=original.Names.find("edge:"+std::to_string(source.Edges().FindIndex(target.Edges()(index))));
    if(found!=original.Names.end())result.Names["edge:"+std::to_string(index)]=found->second;
  }
  if(!proof.empty())result.Names["face:1"]={"loft-loop-profile/"+proof};
  return result;
}
}

LoftBuildResult BuildMultiLoopLoft(const std::vector<LoftProfile>& profiles,const FeatureNode& feature)
{
  if(profiles.size()<2 || profiles.size()>32)throw CadError("INVALID_LOFT_SECTIONS","A multi-loop Loft requires 2 to 32 ordered sections.");
  const std::size_t count=profiles.front().Holes.size();
  if(count<1 || count>16)throw CadError("LOFT_HOLE_MAPPING_REQUIRED","Map 1 to 16 through-hole loops explicitly; use ordinary Loft for a section without holes.");
  auto placed=profiles;
  const auto placement=feature.StringParameters.at("loftPlacement");
  const double spacing=feature.NumberParameters.count("sectionSpacing")?feature.NumberParameters.at("sectionSpacing"):10;
  if(placement!="actual" && placement!="z-spacing")throw CadError("INVALID_PARAMETER","Unknown Loft placement mode.");
  if(placement=="z-spacing" && (!std::isfinite(spacing)||std::abs(spacing)<1e-7||std::abs(spacing)>100000))throw CadError("INVALID_PARAMETER","Loft Z spacing must be non-zero and within 100000 mm.");
  double firstZ=0;
  for(std::size_t index=0;index<placed.size();++index){
    auto& profile=placed[index];validateProfile(profile,count);
    GProp_GProps properties;BRepGProp::SurfaceProperties(profile.Face,properties);
    if(index==0)firstZ=properties.CentreOfMass().Z();
    if(placement=="z-spacing"){
      gp_Trsf shift;shift.SetTranslation(gp_Vec(0,0,firstZ+static_cast<double>(index)*spacing-properties.CentreOfMass().Z()));
      BRepBuilderAPI_Transform transform(profile.Face,shift,true);transform.Build();
      if(!transform.IsDone())throw CadError("LOFT_BUILD_FAILED","Could not place a complete multi-loop section.");
      for(auto& hole:profile.Holes)hole=TopoDS::Wire(transform.ModifiedShape(hole));
      profile.Names=TopologyNaming::Propagate(profile.Face,profile.Names,transform.Shape(),transform);profile.Face=TopoDS::Face(transform.Shape());
    }
  }
  // Place each complete Face once. Re-spacing each isolated loop by its own
  // centroid would move off-center holes on tilted construction planes.
  FeatureNode loopFeature=feature;loopFeature.StringParameters["loftVersion"]="2";loopFeature.StringParameters["loftPlacement"]="actual";loopFeature.StringParameters["loftNamingVersion"]="2";
  std::vector<LoftProfile> sections;
  for(const auto& profile:placed)sections.push_back(loopProfile(profile,BRepTools::OuterWire(profile.Face),profile.Proof.empty()?"":StableDigest("outer/"+profile.Proof)));
  loopFeature.Id=feature.Id+"/multi-loop/outer";auto result=BuildLoft(sections,loopFeature);validSolid(result.Shape);
  const double outerVolume=volume(result.Shape);double removed=0;
  TopoDS_Compound lateral;BRep_Builder compound;compound.MakeCompound(lateral);
  for(TopExp_Explorer face(result.Shape,TopAbs_FACE);face.More();face.Next())if(!face.Current().IsSame(result.StartCap) && !face.Current().IsSame(result.EndCap))compound.Add(lateral,face.Current());
  std::vector<TopoDS_Shape> holes;
  for(std::size_t slot=0;slot<count;++slot){
    sections.clear();for(const auto& profile:placed)sections.push_back(loopProfile(profile,profile.Holes[slot],profile.HoleProofs[slot]));
    loopFeature.Id=feature.Id+"/multi-loop/hole-"+std::to_string(slot+1);const auto tool=BuildLoft(sections,loopFeature);validSolid(tool.Shape);
    BRepExtrema_DistShapeShape wallDistance(lateral,tool.Shape);
    if(!wallDistance.IsDone() || wallDistance.Value()<=10*Precision::Confusion())throw CadError("LOFT_HOLE_OUTSIDE","An inner-loop Loft touches or intersects an outer wall between sections.");
    for(const auto& previous:holes){BRepExtrema_DistShapeShape distance(previous,tool.Shape);if(!distance.IsDone() || distance.Value()<=10*Precision::Confusion())throw CadError("LOFT_HOLES_INTERSECT","Mapped hole Lofts touch, overlap or cross between sections; change their explicit correspondence.");}
    const double holeVolume=volume(tool.Shape),tolerance=std::max(1e-8,holeVolume*1e-7);
    BRepAlgoAPI_Cut outside;outside.SetArguments({tool.Shape});outside.SetTools({result.Shape});outside.SetNonDestructive(true);outside.Build();
    if(!outside.IsDone() || outside.HasErrors() || std::abs(volume(outside.Shape()))>tolerance)throw CadError("LOFT_HOLE_OUTSIDE","An inner-loop Loft is not fully contained in the outer material.");
    BRepAlgoAPI_Cut cut;cut.SetArguments({result.Shape});cut.SetTools({tool.Shape});cut.SetNonDestructive(true);cut.Build();
    if(!cut.IsDone() || cut.HasErrors())throw CadError("LOFT_HOLE_CUT_FAILED","Could not subtract a verified inner-loop Loft.");
    const auto shape=OrientClosedSolidResult(cut.Shape());validSolid(shape);
    auto names=TopologyNaming::Propagate(result.Shape,result.Names,shape,cut);TopologyNaming::Merge(names,TopologyNaming::Propagate(tool.Shape,tool.Names,shape,cut));
    const auto start=nextCap(result.StartCap,shape,cut),end=nextCap(result.EndCap,shape,cut);
    if(wires(start)!=static_cast<int>(slot+2) || wires(end)!=static_cast<int>(slot+2))throw CadError("LOFT_HOLE_CAP_SPLIT","End caps do not retain every mapped inner loop.");
    result={shape,names,start,end};holes.push_back(tool.Shape);removed+=holeVolume;
  }
  if(std::abs(volume(result.Shape)-(outerVolume-removed))>std::max(1e-8,outerVolume*1e-7))throw CadError("LOFT_HOLE_VALIDATION_FAILED","The multi-loop Loft failed its material-volume conservation check.");
  ShapeSerializer topology(result.Shape,0,"");
  for(const auto& cap:std::vector<std::pair<TopoDS_Face,std::string>>{{result.StartCap,"start-cap"},{result.EndCap,"end-cap"}}){const auto& profile=cap.second=="start-cap"?profiles.front():profiles.back();if(!profile.Proof.empty())result.Names["face:"+std::to_string(topology.Faces().FindIndex(cap.first))]={feature.Id+"/loft3/section/"+profile.Proof+'/'+cap.second};}
  for(auto it=result.Names.begin();it!=result.Names.end();)if(it->first.rfind("edge:",0)==0)it=result.Names.erase(it);else ++it;
  TopologyNaming::CompleteEdges(result.Shape,result.Names);return result;
}
}
