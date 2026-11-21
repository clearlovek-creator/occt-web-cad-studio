#include "PrimitiveBuilder.hxx"
#include "../document/CadError.hxx"
#include <BRepAlgoAPI_Cut.hxx>
#include <BRepBuilderAPI_MakeFace.hxx>
#include <BRepBuilderAPI_MakeEdge.hxx>
#include <BRepBuilderAPI_MakePolygon.hxx>
#include <BRepBuilderAPI_MakeWire.hxx>
#include <BRepCheck_Analyzer.hxx>
#include <BRepOffsetAPI_ThruSections.hxx>
#include <BRepPrimAPI_MakeBox.hxx>
#include <BRepPrimAPI_MakeCylinder.hxx>
#include <BRepPrimAPI_MakeCone.hxx>
#include <BRepPrimAPI_MakeSphere.hxx>
#include <BRepPrimAPI_MakeTorus.hxx>
#include <BRepPrimAPI_MakeWedge.hxx>
#include <BRepPrimAPI_MakePrism.hxx>
#include <BRepTools_WireExplorer.hxx>
#include <BRepPrim_OneAxis.hxx>
#include <BRepTools_History.hxx>
#include <TopoDS_Wire.hxx>
#include <TopoDS.hxx>
#include <gp_Ax2.hxx>
#include <gp_Circ.hxx>
#include <gp_Vec.hxx>
#include <cmath>

namespace
{
using namespace occweb;
double number(const FeatureNode& f,const std::string& key,double fallback=0) {const auto found=f.NumberParameters.find(key);return found==f.NumberParameters.end()?fallback:found->second;}
void positive(double value,const std::string& key){if(!std::isfinite(value)||value<=0||value>10000)throw CadError("INVALID_PARAMETER",key+" must be between 0 and 10000 mm.");}
void oneAxisRoles(BRepPrim_OneAxis& maker,NamedSubshapes& roles,const std::string& prefix="")
{
  roles.emplace_back(maker.LateralFace(),prefix+"lateral");
  if(maker.HasTop())roles.emplace_back(maker.TopFace(),prefix+"top");
  if(maker.HasBottom())roles.emplace_back(maker.BottomFace(),prefix+"bottom");
  roles.emplace_back(maker.StartEdge(),prefix+"seam");
  roles.emplace_back(maker.TopEdge(),prefix+"top-rim");
  roles.emplace_back(maker.BottomEdge(),prefix+"bottom-rim");
}
}
namespace occweb
{
PrimitiveBuildResult BuildNamedPrimitive(const FeatureNode& feature)
{
  const gp_Vec xv(number(feature,"csXAxisX",1),number(feature,"csXAxisY"),number(feature,"csXAxisZ"));
  const gp_Vec yv(number(feature,"csYAxisX"),number(feature,"csYAxisY",1),number(feature,"csYAxisZ"));
  const gp_Dir xd(xv),zd(xv.Crossed(yv));
  const gp_Ax2 frame(gp_Pnt(number(feature,"csOriginX"),number(feature,"csOriginY"),number(feature,"csOriginZ")),zd,xd);
  // Preserve the stored coordinate convention for existing projects. Frame
  // normalization/migration must be explicit, not a side effect of naming.
  const gp_Pnt origin=frame.Location().Translated(gp_Vec(xd)*number(feature,"x")+gp_Vec(yv)*number(feature,"y")+gp_Vec(zd)*number(feature,"z"));
  const gp_Ax2 axis(origin,zd,xd);
  const auto point=[&](double x,double y,double z){return origin.Translated(gp_Vec(xd)*x+gp_Vec(axis.YDirection())*y+gp_Vec(zd)*z);};
  const auto rectangle=[&](double w,double d,double z){BRepBuilderAPI_MakePolygon polygon;polygon.Add(point(-w/2,-d/2,z));polygon.Add(point(w/2,-d/2,z));polygon.Add(point(w/2,d/2,z));polygon.Add(point(-w/2,d/2,z));polygon.Close();return polygon.Wire();};
  const auto n=[&](const std::string& key,double fallback=0){return number(feature,key,fallback);};
  const auto p=[&](const std::string& key){const double value=n(key);positive(value,key);return value;};
  NamedSubshapes roles;TopoDS_Shape shape;
  const std::string type=feature.Type;
  if(type=="primitive.box") {
    BRepPrimAPI_MakeBox maker(axis,p("width"),p("depth"),p("height"));shape=maker.Shape();
    roles={{maker.BottomFace(),"bottom"},{maker.TopFace(),"top"},{maker.LeftFace(),"left"},{maker.RightFace(),"right"},{maker.FrontFace(),"front"},{maker.BackFace(),"back"}};
  } else if(type=="primitive.cylinder" || type=="surface.cylinder") {
    BRepPrimAPI_MakeCylinder maker(axis,p("radius"),p("height"));shape=maker.Shape();oneAxisRoles(maker.Cylinder(),roles);
    if(type=="surface.cylinder")shape=maker.Cylinder().LateralFace();
  } else if(type=="primitive.cone" || type=="surface.cone") {
    const double r1=n("radius1"),r2=n("radius2"),height=p("height");
    if(!std::isfinite(r1)||!std::isfinite(r2)||r1<0||r2<0||r1>10000||r2>10000||(r1==0&&r2==0)||(type=="surface.cone"&&r1==r2))throw CadError("INVALID_PARAMETER","Cone radii are invalid.");
    BRepPrimAPI_MakeCone maker(axis,r1,r2,height);shape=maker.Shape();oneAxisRoles(maker.Cone(),roles);
    if(type=="surface.cone")shape=maker.Cone().LateralFace();
  } else if(type=="primitive.sphere" || type=="surface.sphere") {
    BRepPrimAPI_MakeSphere maker(axis,p("radius"));shape=maker.Shape();oneAxisRoles(maker.Sphere(),roles);
    if(type=="surface.sphere")shape=maker.Sphere().LateralFace();
  } else if(type=="primitive.torus") {
    const double major=p("majorRadius"),minor=p("minorRadius");if(major<=minor)throw CadError("INVALID_PARAMETER","Torus majorRadius must exceed minorRadius.");
    BRepPrimAPI_MakeTorus maker(axis,major,minor);shape=maker.Shape();oneAxisRoles(maker.Torus(),roles);
  } else if(type=="primitive.wedge") {
    const double width=p("width"),depth=p("depth"),height=p("height"),top=n("topLength",width/2);
    if(!std::isfinite(top)||top<0||top>width)throw CadError("INVALID_PARAMETER","Wedge topLength must be between zero and width.");
    BRepPrimAPI_MakeWedge maker(axis,width,depth,height,top);shape=maker.Shape();
    const std::vector<std::pair<BRepPrim_Direction,std::string>> faces={{BRepPrim_XMin,"xmin"},{BRepPrim_XMax,"xmax"},{BRepPrim_YMin,"ymin"},{BRepPrim_YMax,"ymax"},{BRepPrim_ZMin,"zmin"},{BRepPrim_ZMax,"zmax"}};
    for(const auto& [direction,role]:faces)if(maker.Wedge().HasFace(direction))roles.emplace_back(maker.Wedge().Face(direction),role);
  } else if(type=="primitive.prism") {
    const double radius=p("radius"),height=p("height");const int sides=int(std::round(n("sides",6)));
    if(sides<3||sides>64)throw CadError("INVALID_PARAMETER","Prism sides must be between 3 and 64.");
    BRepBuilderAPI_MakePolygon polygon;
    for(int i=0;i<sides;i++){const double angle=2*3.14159265358979323846*i/sides;polygon.Add(point(radius*std::cos(angle),radius*std::sin(angle),0));}polygon.Close();
    const TopoDS_Wire wire=polygon.Wire();BRepPrimAPI_MakePrism maker(BRepBuilderAPI_MakeFace(wire).Face(),gp_Vec(zd)*height);shape=maker.Shape();
    roles.emplace_back(maker.FirstShape(),"bottom");roles.emplace_back(maker.LastShape(),"top");
    int side=0;for(BRepTools_WireExplorer edge(wire);edge.More();edge.Next(),side++)for(const auto& face:maker.Generated(edge.Current()))if(face.ShapeType()==TopAbs_FACE)roles.emplace_back(face,"side-"+std::to_string(sides)+'-'+std::to_string(side));
  } else if(type=="primitive.pyramid") {
    const double bw=p("baseWidth"),bd=p("baseDepth"),tw=p("topWidth"),td=p("topDepth"),height=p("height");
    if(tw>bw||td>bd)throw CadError("INVALID_PARAMETER","Pyramid top dimensions cannot exceed the base.");
    const auto bottom=rectangle(bw,bd,0),top=rectangle(tw,td,height);
    BRepOffsetAPI_ThruSections maker(true,false);maker.SetMutableInput(false);maker.AddWire(bottom);maker.AddWire(top);maker.Build();if(!maker.IsDone())throw CadError("BUILD_FAILED","Could not build pyramid.");shape=maker.Shape();
    roles.emplace_back(maker.FirstShape(),"bottom");roles.emplace_back(maker.LastShape(),"top");int side=0;
    for(BRepTools_WireExplorer edge(bottom);edge.More();edge.Next(),side++){const auto face=maker.GeneratedFace(edge.Current());if(!face.IsNull())roles.emplace_back(face,"side-"+std::to_string(side));}
  } else if(type=="primitive.tube") {
    const double outer=p("outerRadius"),inner=p("innerRadius"),height=p("height");if(inner>=outer)throw CadError("INVALID_PARAMETER","Tube innerRadius must be smaller than outerRadius.");
    BRepPrimAPI_MakeCylinder outside(axis,outer,height),inside(axis,inner,height);const auto a=outside.Shape(),b=inside.Shape();
    NamedSubshapes outerRoles,innerRoles;oneAxisRoles(outside.Cylinder(),outerRoles,"outer/");oneAxisRoles(inside.Cylinder(),innerRoles,"inner/");
    for(auto& role:outerRoles)role.second=type+'/'+role.second;for(auto& role:innerRoles)role.second=type+'/'+role.second;
    NCollection_List<TopoDS_Shape> arguments,tools;arguments.Append(a);tools.Append(b);BRepAlgoAPI_Cut maker;maker.SetArguments(arguments);maker.SetTools(tools);maker.SetNonDestructive(true);maker.SetToFillHistory(true);maker.Build();
    if(!maker.IsDone())throw CadError("BUILD_FAILED","Could not build tube.");shape=maker.Shape();
    auto names=TopologyNaming::Propagate(a,TopologyNaming::Seed(a,feature.Id,outerRoles),shape,*maker.History());
    TopologyNaming::Merge(names,TopologyNaming::Propagate(b,TopologyNaming::Seed(b,feature.Id,innerRoles),shape,*maker.History()));TopologyNaming::CompleteEdges(shape,names);
    if(shape.IsNull()||!BRepCheck_Analyzer(shape).IsValid())throw CadError("INVALID_RESULT","The tube is invalid.");return {shape,std::move(names)};
  } else if(type=="surface.rectangle") {
    const auto wire=rectangle(p("width"),p("height"),0);shape=BRepBuilderAPI_MakeFace(wire).Face();roles.emplace_back(shape,"surface");int side=0;
    for(BRepTools_WireExplorer edge(wire);edge.More();edge.Next(),side++)roles.emplace_back(edge.Current(),"side-"+std::to_string(side));
  } else if(type=="surface.disk") {
    const TopoDS_Edge edge=BRepBuilderAPI_MakeEdge(gp_Circ(axis,p("radius"))).Edge();shape=BRepBuilderAPI_MakeFace(BRepBuilderAPI_MakeWire(edge).Wire()).Face();roles.emplace_back(shape,"surface");roles.emplace_back(edge,"rim");
  } else throw CadError("UNSUPPORTED_RECOMPUTE","Unsupported primitive: "+type);
  if(shape.IsNull()||!BRepCheck_Analyzer(shape).IsValid())throw CadError("INVALID_RESULT","Primitive construction returned an invalid shape.");
  for(auto& role:roles)role.second=type+'/'+role.second;
  return {shape,TopologyNaming::Seed(shape,feature.Id,roles)};
}
}
