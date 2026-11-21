#include "../src/document/CadDocument.hxx"
#include "../src/document/CadError.hxx"
#include "../src/features/EdgeDetailLimits.hxx"
#include <BRepBuilderAPI_MakePolygon.hxx>
#include <BRepBuilderAPI_MakeFace.hxx>
#include <BRepPrimAPI_MakePrism.hxx>
#include <BRepFilletAPI_MakeFillet.hxx>
#include <BRepCheck_Analyzer.hxx>
#include <BRepAdaptor_Curve.hxx>
#include <BRep_Tool.hxx>
#include <TopExp_Explorer.hxx>
#include <TopoDS.hxx>
#include <Standard_Failure.hxx>
#include <algorithm>
#include <cmath>
#include <iostream>
#include <stdexcept>
#include <string>

using namespace occweb;
void require(bool value,const std::string& message){if(!value)throw std::runtime_error(message);}
void near(double actual,double expected,const std::string& label){require(std::abs(actual-expected)<1e-8*std::max(1.0,std::abs(expected)),label+": "+std::to_string(actual)+" != "+std::to_string(expected));}
std::string vertical(CadDocument& document,const std::string& body,double height){
  const auto view=JsonParser(document.BodyPresentation("edges",body)).Parse();
  for(const auto& edge:view.At("edges").AsArray()){
    const auto id=edge.GetString("edgeId");const auto measured=JsonParser(document.Measure("edge",body,"edge",id)).Parse();
    const auto& center=measured.At("centroid").AsArray();
    if(std::abs(center[0].AsNumber())<1e-8&&std::abs(center[1].AsNumber())<1e-8&&std::abs(measured.GetNumber("length")-height)<1e-8)return id;
  }
  throw std::runtime_error("Thin plate vertical corner not found");
}
double mass(CadDocument& document,const std::string& body){
  const auto checked=JsonParser(document.ShapeCheck("check",body)).Parse();require(checked.At("valid").AsBoolean(),"Edge detail must produce a valid BRep");
  return JsonParser(document.Measure("volume",body,"body","")).Parse().GetNumber("volume");
}
int main(){try{
  const double pi=std::acos(-1.0);
  for(const bool fillet:{true,false}){
    CadDocument document(fillet?"thin-fillet":"thin-chamfer");const auto base=JsonParser(document.CreateBox("base",40,30,1,false)).Parse();const auto body=base.GetString("bodyId"),feature=base.At("features").AsArray().front().GetString("id"),edge=vertical(document,body,1);
    const auto result=JsonParser(fillet?document.Fillet("round",document.Revision(),body,edge,5):document.Chamfer("bevel",document.Revision(),body,edge,5)).Parse();
    near(mass(document,body),1200-(fillet?25-25*pi/4:12.5),"Thin plate creation volume");
    document.UpdateFeature("thin-recompute",document.Revision(),feature,JsonParser(R"({"width":80,"depth":50,"height":0.125})").Parse());
    near(mass(document,body),500-.125*(fillet?25-25*pi/4:12.5),"Changed thin plate volume");
    const auto detail=result.At("features").AsArray().back().GetString("id");document.UpdateFeature("detail-edit",document.Revision(),detail,JsonParser(fillet?R"({"radius":8})":R"({"distance":8})").Parse());
    near(mass(document,body),500-.125*(fillet?64-16*pi:32),"Local detail edit volume");
    const auto before=document.Summary("same");bool rejected=false;
    try{const auto view=JsonParser(document.BodyPresentation("current",body)).Parse();const auto current=view.At("edges").AsArray().front().GetString("edgeId");if(fillet)document.Fillet("invalid",document.Revision(),body,current,2000);else document.Chamfer("invalid",document.Revision(),body,current,2000);}catch(const CadError&){rejected=true;}
    require(rejected,"Invalid size/selection must still be refused");require(document.Summary("same")==before,"Rejected edge edit changed the document");
    std::cout<<"PASS thin plate "<<(fillet?"fillet":"chamfer")<<" uses local OCCT feasibility through upstream and detail recomputation\n";
  }
  // A shallow (170-degree interior) polygonal corner needs a large radius but
  // only a small tangency setback. An AABB or angle-blind size rule rejects it.
  BRepBuilderAPI_MakePolygon polygon;polygon.Add(gp_Pnt(0,0,0));polygon.Add(gp_Pnt(40,0,0));polygon.Add(gp_Pnt(40*std::cos(170*pi/180),40*std::sin(170*pi/180),0));polygon.Close();
  const auto shallow=BRepPrimAPI_MakePrism(BRepBuilderAPI_MakeFace(polygon.Wire()).Face(),gp_Vec(0,0,.125)).Shape();bool tested=false;
  for(TopExp_Explorer edges(shallow,TopAbs_EDGE);edges.More();edges.Next()){
    const auto edge=TopoDS::Edge(edges.Current());BRepAdaptor_Curve curve(edge);const auto a=curve.Value(curve.FirstParameter()),b=curve.Value(curve.LastParameter());
    if(std::abs(a.X())>1e-8||std::abs(a.Y())>1e-8||std::abs(b.X())>1e-8||std::abs(b.Y())>1e-8)continue;
    ValidatePlanarEdgeDetail(shallow,edge,10,true);BRepFilletAPI_MakeFillet fillet(shallow);fillet.Add(10,edge);fillet.Build();require(fillet.IsDone()&&BRepCheck_Analyzer(fillet.Shape()).IsValid(),"Shallow corner must permit the actual angle-correct fillet");tested=true;break;
  }
  require(tested,"Shallow corner regression did not locate the actual vertical edge");std::cout<<"PASS shallow planar corner uses angle-correct tangency setback\n";
  return 0;
}catch(const Standard_Failure& error){std::cerr<<error.what()<<'\n';return 1;}catch(const std::exception& error){std::cerr<<error.what()<<'\n';return 1;}}
