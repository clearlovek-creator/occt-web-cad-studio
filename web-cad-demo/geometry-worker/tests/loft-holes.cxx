#include "../src/features/LoftBuilder.hxx"
#include "../src/document/CadError.hxx"
#include "../src/document/ShapeFingerprint.hxx"
#include "../src/presentation/ShapeSerializer.hxx"
#include <BRepBuilderAPI_MakeEdge.hxx>
#include <BRepBuilderAPI_MakeFace.hxx>
#include <BRepBuilderAPI_MakePolygon.hxx>
#include <BRepBuilderAPI_MakeWire.hxx>
#include <BRepBuilderAPI_Transform.hxx>
#include <BRepCheck_Analyzer.hxx>
#include <BRepGProp.hxx>
#include <BRepTools.hxx>
#include <BRep_Builder.hxx>
#include <GProp_GProps.hxx>
#include <TopExp_Explorer.hxx>
#include <TopoDS.hxx>
#include <gp_Circ.hxx>
#include <gp_Pln.hxx>
#include <gp_Pnt2d.hxx>
#include <filesystem>
#include <iostream>
#include <functional>
#include <chrono>
#include <algorithm>
#include <cmath>

using namespace occweb;
namespace
{
void require(bool condition,const char* message){if(!condition)throw std::runtime_error(message);}
double measure(const TopoDS_Shape& shape,bool solid){GProp_GProps p;if(solid)BRepGProp::VolumeProperties(shape,p);else BRepGProp::SurfaceProperties(shape,p);return p.Mass();}
bool near(double a,double b){return std::abs(a-b)<1e-5*std::max(1.,std::abs(b));}
int countWires(const TopoDS_Face& face){int count=0;for(TopExp_Explorer wire(face,TopAbs_WIRE);wire.More();wire.Next())++count;return count;}
void nameProfile(LoftProfile& profile,const std::string& id)
{
  profile.Proof=StableDigest(id);NamedSubshapes roles={{profile.Face,"section"}};int edge=0;
  for(TopExp_Explorer item(profile.Face,TopAbs_EDGE);item.More();item.Next())roles.emplace_back(item.Current(),"edge-"+std::to_string(++edge));
  profile.Names=TopologyNaming::Seed(profile.Face,id,roles);
}
LoftProfile profile(double z,const std::vector<gp_Pnt2d>& centers,const std::string& id,double holeRadius=1)
{
  const auto circle=[&](double x,double y,double radius){return BRepBuilderAPI_MakeWire(BRepBuilderAPI_MakeEdge(gp_Circ(gp_Ax2(gp_Pnt(x,y,z),gp_Dir(0,0,1)),radius))).Wire();};
  BRepBuilderAPI_MakeFace face(gp_Pln(gp_Pnt(0,0,z),gp_Dir(0,0,1)),circle(0,0,10),true);LoftProfile p;p.Proof=StableDigest(id);
  for(const auto& center:centers){auto wire=circle(center.X(),center.Y(),holeRadius);wire.Reverse();face.Add(wire);p.Holes.push_back(wire);p.HoleProofs.push_back(StableDigest(id+"/hole-"+std::to_string(p.Holes.size())));}
  p.Face=face.Face();require(BRepCheck_Analyzer(p.Face).IsValid(),"Native multi-loop fixture is not valid");
  nameProfile(p,id);return p;
}
LoftProfile mixedProfile(double z,const std::string& id)
{
  const auto rectangle=[&](double xmin,double ymin,double xmax,double ymax){BRepBuilderAPI_MakePolygon polygon;for(const auto& p:std::vector<gp_Pnt>{{xmin,ymin,z},{xmax,ymin,z},{xmax,ymax,z},{xmin,ymax,z}})polygon.Add(p);polygon.Close();return polygon.Wire();};
  BRepBuilderAPI_MakeFace face(gp_Pln(gp_Pnt(0,0,z),gp_Dir(0,0,1)),rectangle(-15,-10,15,10),true);LoftProfile p;
  p.Holes={BRepBuilderAPI_MakeWire(BRepBuilderAPI_MakeEdge(gp_Circ(gp_Ax2(gp_Pnt(-5,0,z),gp_Dir(0,0,1)),1))).Wire(),rectangle(3,-2,7,2)};
  for(auto& hole:p.Holes){hole.Reverse();face.Add(hole);p.HoleProofs.push_back(StableDigest(id+"/hole-"+std::to_string(p.HoleProofs.size())));}
  p.Face=face.Face();require(BRepCheck_Analyzer(p.Face).IsValid(),"Mixed-loop fixture invalid");nameProfile(p,id);return p;
}
void rejects(const std::function<void()>& run,const std::string& code){bool found=false;try{run();}catch(const CadError& error){found=error.Code()==code;if(!found)std::cerr<<"Expected "<<code<<", got "<<error.Code()<<": "<<error.what()<<'\n';}require(found,"Invalid multi-loop correspondence was not rejected as required");}
}
int main(){try{
  const double pi=std::acos(-1.);
  FeatureNode feature;feature.Id="loft-holes";feature.StringParameters={{"loftVersion","3"},{"loftPlacement","actual"},{"loftRuled","false"},{"loftNamingVersion","2"}};
  auto first=profile(7,{{-3,0},{3,0}},"first"),last=profile(27,{{-3,0},{3,0}},"last");
  const auto firstFingerprint=ShapeFingerprint(first.Face),lastFingerprint=ShapeFingerprint(last.Face);
  const auto result=BuildLoft({first,last},feature);require(BRepCheck_Analyzer(result.Shape).IsValid(),"Multi-loop result is invalid");
  require(ShapeFingerprint(first.Face)==firstFingerprint&&ShapeFingerprint(last.Face)==lastFingerprint,"Multi-loop construction modified its source BREP");
  require(near(measure(result.Shape,true),pi*98*20),"Through-hole volume was filled or removed incorrectly");
  require(countWires(result.StartCap)==3 && countWires(result.EndCap)==3,"Every end cap must keep both holes");
  require(near(measure(result.StartCap,false),pi*98),"End cap material area does not exclude both holes");
  require(!result.Names.empty(),"Proven multi-loop output lost all topology names");
  std::cout<<"PASS two explicitly mapped holes keep exact volume, cap area and names\n";

  ShapeSerializer topology(result.Shape,0,"");std::string selector;
  for(const auto& [key,roots]:result.Names)if(key.rfind("face:",0)==0)for(const auto& root:roots)if(root.find("/multi-loop/hole-1/")!=std::string::npos)selector=TopologyNaming::CaptureSelection(result.Shape,result.Names,"face",std::stoi(key.substr(5)));
  require(!selector.empty(),"Verified first hole wall has no persistent face selector");
  const auto resized=BuildLoft({first,profile(27,{{-3,0},{3,0}},"last",1.5)},feature);
  require(TopologyNaming::ResolveSelection(resized.Shape,resized.Names,selector)>0,"A radius edit lost the proven inner-wall identity");
  auto unproven=last;unproven.HoleProofs[0].clear();const auto unnamed=BuildLoft({first,unproven},feature);
  for(const auto& [key,roots]:unnamed.Names)for(const auto& root:roots)require(root.find("/multi-loop/hole-1/")==std::string::npos,"An unproven hole borrowed naming evidence from another loop");
  std::cout<<"PASS inner-wall selectors survive radius changes and incomplete loop proofs stay unproven\n";

  auto crossed=last;std::swap(crossed.Holes[0],crossed.Holes[1]);std::swap(crossed.HoleProofs[0],crossed.HoleProofs[1]);
  rejects([&]{BuildLoft({first,crossed},feature);},"LOFT_HOLES_INTERSECT");
  auto missing=last;missing.Holes.pop_back();missing.HoleProofs.pop_back();rejects([&]{BuildLoft({first,missing},feature);},"LOFT_HOLE_MAPPING_REQUIRED");
  auto duplicate=last;duplicate.Holes[1]=duplicate.Holes[0];rejects([&]{BuildLoft({first,duplicate},feature);},"INVALID_LOFT_HOLE_MAPPING");
  auto outer=last;outer.Holes[0]=BRepTools::OuterWire(outer.Face);rejects([&]{BuildLoft({first,outer},feature);},"INVALID_LOFT_HOLE_MAPPING");
  auto legacy=feature;legacy.StringParameters["loftVersion"]="2";rejects([&]{BuildLoft({first,last},legacy);},"LOFT_PROFILE_HOLES_UNSUPPORTED");
  std::cout<<"PASS crossing, missing, duplicate and outer-wire mappings fail; v2 still rejects holes\n";

  auto spaced=feature;spaced.StringParameters["loftPlacement"]="z-spacing";spaced.NumberParameters["sectionSpacing"]=35;
  const auto moved=BuildLoft({first,last},spaced);require(near(measure(moved.Shape,true),pi*98*35),"Spacing did not apply to whole hole profiles");
  GProp_GProps p;BRepGProp::SurfaceProperties(last.Face,p);require(near(p.CentreOfMass().Z(),27),"Loft mutated its input Face");
  BRepGProp::SurfaceProperties(moved.EndCap,p);require(near(p.CentreOfMass().Z(),42),"Spacing used the wrong original section plane");
  spaced.NumberParameters["sectionSpacing"]=-35;require(near(measure(BuildLoft({first,last},spaced).Shape,true),pi*98*35),"Negative spacing changed positive material volume");
  std::cout<<"PASS positive and negative spacing preserve input geometry and through-holes\n";

  auto tilted=last;gp_Trsf rotation;rotation.SetRotation(gp_Ax1(gp_Pnt(0,0,27),gp_Dir(1,0,0)),.15);BRepBuilderAPI_Transform transform(tilted.Face,rotation,true);transform.Build();
  for(auto& wire:tilted.Holes)wire=TopoDS::Wire(transform.ModifiedShape(wire));tilted.Names=TopologyNaming::Propagate(tilted.Face,tilted.Names,transform.Shape(),transform);tilted.Face=TopoDS::Face(transform.Shape());
  const auto tilt=BuildLoft({first,tilted},feature);require(BRepCheck_Analyzer(tilt.Shape).IsValid(),"Nonparallel multi-loop Loft is invalid");require(near(measure(tilt.EndCap,false),pi*98),"Tilted end cap lost its real section area");
  std::cout<<"PASS nonparallel real section planes retain both end-cap holes\n";

  auto ruled=feature;ruled.StringParameters["loftRuled"]="true";const auto mixed=BuildLoft({mixedProfile(0,"mixed-first"),mixedProfile(20,"mixed-last")},ruled);
  require(near(measure(mixed.Shape,true),(600-pi-16)*20),"Mixed polygon/circle hole Loft changed material volume");require(countWires(mixed.StartCap)==3&&countWires(mixed.EndCap)==3,"Mixed-loop end caps lost an inner boundary");
  std::cout<<"PASS ruled rectangular sections retain independent circular and polygonal holes\n";

  const auto source=mixedProfile(0,"proof-source");ShapeSerializer sourceTopology(source.Face,0,"");auto reference=JsonValue::MakeObject();auto& fields=reference.ChangeObject();fields["bodyIdentity"]=JsonValue(std::string(32,'a'));fields["featureIdentity"]=JsonValue(std::string(32,'b'));fields["sectionId"]=JsonValue(std::string("section-1"));fields["selector"]=JsonValue(TopologyNaming::CaptureSelection(source.Face,source.Names,"face",1));
  auto selectors=JsonValue::MakeArray();std::vector<int> polygonEdges;
  for(std::size_t slot=0;slot<source.Holes.size();++slot){int firstEdge=0;for(TopExp_Explorer edge(source.Holes[slot],TopAbs_EDGE);edge.More();edge.Next()){const int index=sourceTopology.Edges().FindIndex(edge.Current());if(!firstEdge)firstEdge=index;if(slot==1)polygonEdges.push_back(index);}selectors.ChangeArray().push_back(JsonValue(TopologyNaming::CaptureSelection(source.Face,source.Names,"edge",firstEdge)));}
  fields["holeSelectors"]=selectors;const auto captured=ResolveLoftProfile(source.Face,source.Names,reference);require(polygonEdges.size()==4,"Polygon fixture must have four selectable edges");fields["holeSelectors"].ChangeArray()[1]=JsonValue(TopologyNaming::CaptureSelection(source.Face,source.Names,"edge",polygonEdges[1]));const auto alternate=ResolveLoftProfile(source.Face,source.Names,reference);
  require(!captured.HoleProofs[1].empty()&&captured.HoleProofs==alternate.HoleProofs,"Changing the representative edge renamed the same proven hole boundary");
  std::cout<<"PASS polygon hole identity uses its full boundary, not the chosen representative edge\n";

  const auto file=(std::filesystem::temp_directory_path()/("loft-holes-"+std::to_string(std::chrono::steady_clock::now().time_since_epoch().count())+".brep")).string();
  try{require(BRepTools::Write(result.Shape,file.c_str()),"Could not save multi-loop BREP");TopoDS_Shape reopened;BRep_Builder builder;require(BRepTools::Read(reopened,file.c_str(),builder),"Could not reopen multi-loop BREP");require(BRepCheck_Analyzer(reopened).IsValid()&&near(measure(reopened,true),pi*98*20),"BREP roundtrip changed multi-loop geometry");std::filesystem::remove(file);}catch(...){std::filesystem::remove(file);throw;}
  std::cout<<"PASS exact multi-loop BREP survives file roundtrip\n";return 0;
}catch(const std::exception& error){std::cerr<<error.what()<<'\n';return 1;}}
