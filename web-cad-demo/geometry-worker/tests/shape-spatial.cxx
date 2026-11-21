#include "../src/document/ShapeSpatial.hxx"
#include "../src/document/ShapeFingerprint.hxx"
#include "../src/document/CadDocument.hxx"
#include "../src/protocol/Json.hxx"
#include <BRepPrimAPI_MakeBox.hxx>
#include <BRepPrimAPI_MakeSphere.hxx>
#include <BRepPrimAPI_MakeCylinder.hxx>
#include <BRepPrimAPI_MakeTorus.hxx>
#include <BRepBuilderAPI_Transform.hxx>
#include <BRepBuilderAPI_MakeFace.hxx>
#include <BRepBuilderAPI_MakeEdge.hxx>
#include <BRepMesh_IncrementalMesh.hxx>
#include <BRepTools.hxx>
#include <gp_Pln.hxx>
#include <gp_Ax1.hxx>
#include <gp_Vec.hxx>
#include <iostream>
#include <stdexcept>
#include <cmath>
#include <limits>
using namespace occweb;
void require(bool yes,const char* message){if(!yes)throw std::runtime_error(message);}
int main(){try{
  std::vector<TopoDS_Shape> shapes={BRepPrimAPI_MakeBox(gp_Pnt(-.000000123456789,-20,30),10,20,30).Shape(),BRepPrimAPI_MakeSphere(12.3456789123).Shape(),BRepPrimAPI_MakeCylinder(7.123456789,15.987654321).Shape(),BRepPrimAPI_MakeTorus(30,4.123456789).Shape(),BRepBuilderAPI_MakeFace(gp_Pln(gp_Pnt(10,20,30),gp_Dir(0,0,1)),-3,7,-4,8).Shape(),BRepBuilderAPI_MakeEdge(gp_Pnt(10,20,30),gp_Pnt(11,22,33)).Shape()};
  gp_Trsf rotation;rotation.SetRotation(gp_Ax1(gp_Pnt(0,0,0),gp_Dir(1,2,3)),.319);shapes.push_back(BRepBuilderAPI_Transform(shapes[1],rotation,true).Shape());
  for(const auto& shape:shapes){BRepTools::Clean(shape);const auto fingerprint=ShapeFingerprint(shape),bounds=SpatialBoundsJson(shape),obb=SpatialObbJson(shape);
    require(bounds!="null","Fixture must have finite analytic bounds");
    for(double deflection:{2.,.7,.03}){BRepMesh_IncrementalMesh mesh(shape,deflection,false,.4,true);require(SpatialBoundsJson(shape)==bounds,"Analytic bounds changed after meshing");require(SpatialObbJson(shape)==obb,"BRep OBB changed after meshing");require(ShapeFingerprint(shape)==fingerprint,"Spatial query changed exact BRep evidence");}
    BRepTools::Clean(shape);require(SpatialBoundsJson(shape)==bounds,"Bounds changed after mesh cleanup");
    const auto parsed=JsonParser(obb).Parse();require(!parsed.GetBooleanOr("exact",true)&&!parsed.GetBooleanOr("minimum",true)&&!parsed.GetBooleanOr("triangulationUsed",true),"OBB must not claim exact minimum-volume geometry");
  }
  require(SpatialBoundsJson(TopoDS_Shape())=="null","Void geometry cannot invent a zero box");
  const double precise=.00000012345678912345;require(JsonParser(SpatialNumber(precise)).Parse().AsNumber()==precise,"Double precision must round trip");require(SpatialNumber(-0.)=="0","Signed zero must be normalized");
  bool rejected=false;try{SpatialNumber(std::numeric_limits<double>::infinity());}catch(...){rejected=true;}require(rejected,"Non-finite spatial JSON must fail");
  const auto sheet=BuildSpatialMetadata(shapes[4],"sheet"),wire=BuildSpatialMetadata(shapes[5],"wire");const auto center=JsonParser('{'+sheet->Fields.substr(1)+'}').Parse().At("centroid").AsArray();require(std::abs(center[0].AsNumber()-12)<1e-12&&std::abs(center[1].AsNumber()-22)<1e-12&&center[2].AsNumber()==30,"Sheet center must use surface mass, not zero volume mass");
  require(wire->Fields.find("31.5")!=std::string::npos,"Wire center must use line mass");
  CadDocument document("spatial");document.CreatePrimitive("create","primitive.cylinder",JsonParser(R"({"radius":7.123456789,"height":15.987654321})").Parse());const auto cold=JsonParser(document.Summary("cold")).Parse();document.BodyPresentation("mesh","body-1");const auto warm=JsonParser(document.Summary("warm")).Parse();require(JsonSerialize(cold.At("bodyMetadata"))==JsonSerialize(warm.At("bodyMetadata")),"Document metadata changed after presentation");
  const auto measurement=JsonParser(document.Measure("measure","body-1","body","")).Parse();require(JsonSerialize(measurement.At("bounds"))==JsonSerialize(cold.At("bodyMetadata").AsArray()[0].At("bounds")),"Measure and metadata bounds disagree");
  std::cout<<"PASS analytic spatial policy, cache-independent bounds/OBB, round-trip precision and surface/wire centroids\n";
}catch(const std::exception& error){std::cerr<<error.what()<<'\n';return 1;}return 0;}
