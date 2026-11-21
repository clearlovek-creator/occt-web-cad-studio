#include "../src/features/SweepBuilder.hxx"
#include "../src/features/PrimitiveBuilder.hxx"
#include "../src/presentation/ShapeSerializer.hxx"
#include "../src/document/CadError.hxx"
#include "../src/document/ShapeFingerprint.hxx"
#include <BRepBuilderAPI_MakeEdge.hxx>
#include <BRepGProp.hxx>
#include <GProp_GProps.hxx>
#include <gp_Circ.hxx>
#include <TopoDS.hxx>
#include <STEPControl_Writer.hxx>
#include <IFSelect_ReturnStatus.hxx>
#include <GeomAPI_Interpolate.hxx>
#include <Geom_BSplineCurve.hxx>
#include <NCollection_HArray1.hxx>
#include <TopoDS_Wire.hxx>
#include <BRepBuilderAPI_MakeWire.hxx>
#include <filesystem>
#include <cmath>
#include <iostream>
#include <stdexcept>
using namespace occweb;
void require(bool ok,const std::string& why){if(!ok)throw std::runtime_error(why);}
double volume(const TopoDS_Shape& shape){GProp_GProps properties;BRepGProp::VolumeProperties(shape,properties);return properties.Mass();}
int main(int argc,char** argv){try{
  const double pi=std::acos(-1.0);
  if(argc==3 && std::string(argv[1])=="--fixture-output"){
    const auto directory=std::filesystem::u8path(argv[2]);std::filesystem::create_directories(directory);
    const auto save=[&](const std::string& name,const TopoDS_Shape& shape){STEPControl_Writer writer;require(writer.Transfer(shape,STEPControl_AsIs)==IFSelect_RetDone,"Could not transfer curve fixture");require(writer.Write((directory/name).u8string().c_str())==IFSelect_RetDone,"Could not write curve fixture");};
    save("arc.step",BRepBuilderAPI_MakeEdge(gp_Circ(gp_Ax2(gp_Pnt(0,0,0),gp_Dir(0,0,1)),20),0,pi/2).Edge());
    Handle(NCollection_HArray1<gp_Pnt>) points=new NCollection_HArray1<gp_Pnt>(1,4);points->SetValue(1,gp_Pnt(0,0,0));points->SetValue(2,gp_Pnt(10,0,10));points->SetValue(3,gp_Pnt(10,10,20));points->SetValue(4,gp_Pnt(0,10,30));GeomAPI_Interpolate interpolation(points,false,1e-7);interpolation.Perform();require(interpolation.IsDone(),"Could not construct spline fixture");save("spline.step",BRepBuilderAPI_MakeEdge(interpolation.Curve()).Edge());
    BRepBuilderAPI_MakeWire wire;wire.Add(BRepBuilderAPI_MakeEdge(gp_Pnt(0,0,0),gp_Pnt(0,0,10)).Edge());wire.Add(BRepBuilderAPI_MakeEdge(gp_Pnt(0,0,10),gp_Pnt(0,0,20)).Edge());save("g1.step",wire.Wire());
    std::cout<<"PASS retained STEP arc/spline/multi-edge path fixtures\n";return 0;
  }
  FeatureNode disk;disk.Id="profile";disk.Type="surface.disk";disk.NumberParameters={{"radius",2}};const auto profileShape=BuildNamedPrimitive(disk);ShapeSerializer t(profileShape.Shape,0,"");
  JsonValue reference=JsonValue::MakeObject();reference.ChangeObject()["bodyIdentity"]=JsonValue(std::string(32,'a'));reference.ChangeObject()["featureIdentity"]=JsonValue(std::string(32,'b'));reference.ChangeObject()["selector"]=JsonValue(TopologyNaming::CaptureSelection(profileShape.Shape,profileShape.Names,"face",1));
  const auto profile=ResolveSweepProfile(profileShape.Shape,profileShape.Names,reference);
  FeatureNode feature;feature.Id="sweep";feature.Type="detail.sweep";feature.StringParameters={{"sweepVersion","2"},{"sweepPlacement","align-start"},{"sweepFrame","corrected-frenet"},{"sweepReverse","false"}};
  require(IsCurveSweep(feature),"A v2 definition must select the real curve builder");
  feature.StringParameters["sweepVersion"]="3";bool unsupported=false;try{IsCurveSweep(feature);}catch(const CadError& error){unsupported=error.Code()=="UNSUPPORTED_SWEEP_VERSION";}require(unsupported,"Unknown sweep versions must not fall back to legacy vector replay");feature.StringParameters["sweepVersion"]="2";
  feature.StringParameters["sweepProfile"]="{\"bodyId\":\"profile\",\"featureId\":\"profile-source\"}";
  feature.StringParameters["sweepPath"]="{\"bodyId\":\"path\",\"featureId\":\"path-source\",\"edges\":[{}, {\"inputId\":\"path-kept\"}]}";
  const auto slots=CurveSweepInputs(feature);require(slots.size()==3&&slots[0].Id=="profile"&&slots[1].Id=="legacy-path-1"&&slots[2].Id=="path-kept","Pre-slot v2 files require deterministic legacy keys without changing retained keys");
  const auto oldDefinition=feature.StringParameters;CurveSweepInputs(feature);require(feature.StringParameters==oldDefinition,"Inspecting curve input keys must not rewrite persisted metadata");
  auto invalid=feature;invalid.StringParameters["sweepPath"]="{\"edges\":[{\"inputId\":\"profile\"}]}";bool badKey=false;try{CurveSweepInputs(invalid);}catch(const CadError&){badKey=true;}require(badKey,"Path input keys must not collide with the profile role");
  const auto circle=BRepBuilderAPI_MakeEdge(gp_Circ(gp_Ax2(gp_Pnt(0,0,0),gp_Dir(0,0,1)),20)).Edge();
  const auto before=ShapeFingerprint(profileShape.Shape),pathBefore=ShapeFingerprint(circle);const auto closed=BuildCurveSweep(profile,{{circle},std::string(64,'c')},feature);
  require(std::abs(volume(closed.Shape)-160*pi*pi)<1e-4,"A real circular sweep must have exact torus volume");require(ShapeFingerprint(profileShape.Shape)==before,"Building and checking a sweep must not mutate the profile source");
  require(ShapeFingerprint(circle)==pathBefore,"Wire assembly and sweep checking must not mutate the source Edge");
  std::cout<<"PASS exact closed circular path and unchanged source geometry\n";
  const auto arc=BRepBuilderAPI_MakeEdge(gp_Circ(gp_Ax2(gp_Pnt(0,0,0),gp_Dir(0,0,1)),20),0,pi/2).Edge();const auto open=BuildCurveSweep(profile,{{arc},std::string(64,'d')},feature);
  require(std::abs(volume(open.Shape)-40*pi*pi)<1e-4,"A real quarter-circle sweep must use arc length, not a chord");bool start=false,end=false;for(const auto& [key,roots]:open.Names)for(const auto& root:roots){start|=root.find("/start-cap/")!=std::string::npos;end|=root.find("/end-cap/")!=std::string::npos;}require(start&&end,"Open curved paths must distinguish their real endpoint caps");
  feature.StringParameters["sweepReverse"]="true";require(std::abs(volume(BuildCurveSweep(profile,{{arc},std::string(64,'d')},feature).Shape)-40*pi*pi)<1e-4,"Reversed curved paths must remain valid");feature.StringParameters["sweepReverse"]="false";
  std::cout<<"PASS real arc length, endpoint naming and explicit direction reversal\n";
  const auto first=BRepBuilderAPI_MakeEdge(gp_Pnt(0,0,0),gp_Pnt(0,0,10)).Edge(),second=BRepBuilderAPI_MakeEdge(gp_Pnt(0,0,10),gp_Pnt(0,0,20)).Edge();
  require(std::abs(volume(BuildCurveSweep(profile,{{first,second},std::string(64,'e')},feature).Shape)-80*pi)<1e-4,"Connected G1 multi-edge paths must traverse all edges");
  const auto sharp=BRepBuilderAPI_MakeEdge(gp_Pnt(0,0,10),gp_Pnt(10,0,10)).Edge(),gap=BRepBuilderAPI_MakeEdge(gp_Pnt(0,0,15),gp_Pnt(0,0,25)).Edge();
  for(const auto& invalid:{SweepPath{{first,sharp},"proof"},SweepPath{{first,gap},"proof"}}){bool rejected=false;try{BuildCurveSweep(profile,invalid,feature);}catch(const CadError&){rejected=true;}require(rejected,"Sharp and disconnected paths must be rejected, not approximated");}
  std::cout<<"PASS ordered G1 path validation and explicit sharp/gap errors\n";
  feature.StringParameters["sweepPlacement"]="actual";bool rejected=false;try{BuildCurveSweep(profile,{{arc},"proof"},feature);}catch(const CadError& error){rejected=error.Code()=="SWEEP_PROFILE_PLACEMENT";}require(rejected,"Actual placement must not silently move or rotate the selected Face");
  std::cout<<"PASS actual placement refuses an incompatible profile without alignment\n";
  return 0;
}catch(const std::exception& error){std::cerr<<error.what()<<'\n';return 1;}}
