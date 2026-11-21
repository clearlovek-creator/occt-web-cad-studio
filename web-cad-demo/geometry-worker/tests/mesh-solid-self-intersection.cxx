#include "../src/mesh/MeshDiagnostics.hxx"
#include "../src/mesh/MeshPreparation.hxx"
#include "../src/document/CadError.hxx"
#include "../src/protocol/Json.hxx"
#include <BRepBuilderAPI_MakePolygon.hxx>
#include <BRepBuilderAPI_MakeFace.hxx>
#include <BRepBuilderAPI_MakeSolid.hxx>
#include <BRepBuilderAPI_Sewing.hxx>
#include <BRepPrimAPI_MakeBox.hxx>
#include <BRepGProp.hxx>
#include <BRepTools.hxx>
#include <BRep_Builder.hxx>
#include <GProp_GProps.hxx>
#include <TopExp.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Shell.hxx>
#include <TopoDS_Solid.hxx>
#include <TopoDS_Compound.hxx>
#include <TopTools_IndexedMapOfShape.hxx>
#include <STEPControl_Writer.hxx>
#include <array>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <sstream>
#include <stdexcept>
using namespace occweb;
void require(bool value,const std::string& message){if(!value)throw std::runtime_error(message);}
MeshPreparationBody source(const TopoDS_Shape& shape){MeshPreparationBody body{"body-1","Folded solid assembly","solid",std::string(32,'a'),std::string(32,'b'),1,shape,{}};TopTools_IndexedMapOfShape faces;TopExp::MapShapes(shape,TopAbs_FACE,faces);for(int i=1;i<=faces.Extent();++i)body.FaceIds.push_back("face-1-"+std::to_string(i));return body;}
int selfErrors(const JsonValue& report){int count=0;for(const auto& issue:report.At("issues").AsArray())if(issue.GetString("code")=="SELF_INTERSECTION"&&issue.GetString("severity")=="error")++count;return count;}
TopoDS_Shape folded(){
  const std::array<gp_Pnt,8> p={gp_Pnt(0,0,0),gp_Pnt(2,0,0),gp_Pnt(2,2,0),gp_Pnt(0,2,0),gp_Pnt(0,0,2),gp_Pnt(2,0,2),gp_Pnt(2,2,2),gp_Pnt(-.4,1,-.5)};
  const int triangles[12][3]={{0,2,1},{0,3,2},{4,5,6},{4,6,7},{0,1,5},{0,5,4},{1,2,6},{1,6,5},{2,3,7},{2,7,6},{3,0,4},{3,4,7}};
  BRepBuilderAPI_Sewing sewing(1e-8);
  for(const auto& tri:triangles){BRepBuilderAPI_MakePolygon wire;for(int index:tri)wire.Add(p[index]);wire.Close();sewing.Add(BRepBuilderAPI_MakeFace(wire.Wire()).Face());}
  sewing.Perform();const auto shell=sewing.SewedShape();require(shell.ShapeType()==TopAbs_SHELL&&sewing.NbFreeEdges()==0,"Folded fixture is not one closed Shell");
  TopoDS_Solid solid=BRepBuilderAPI_MakeSolid(TopoDS::Shell(shell)).Solid();GProp_GProps props;BRepGProp::VolumeProperties(solid,props);if(props.Mass()<0)solid.Reverse();return solid;
}
std::string brep(const TopoDS_Shape& shape){std::ostringstream out;BRepTools::Write(shape,out);return out.str();}
int main(){try{
  std::string line;std::filesystem::path directory;if(std::getline(std::cin,line)&&!line.empty()){directory=JsonParser(line).Parse().GetString("directory");std::filesystem::create_directories(directory);}
  const auto bad=folded();const auto singleBody=source(bad);const auto single=DiagnoseMeshShape(bad,&singleBody,1e-8,true);std::cout<<"single "<<JsonSerialize(single)<<std::endl;
  require(single.GetBooleanOr("valid",false),"Fixture must be topologically valid so this is a geometric self-intersection regression");require(selfErrors(single)>0,"Single folded Solid was not diagnosed as self-intersecting");
  BRep_Builder builder;TopoDS_Compound mixed;builder.MakeCompound(mixed);builder.Add(mixed,bad);builder.Add(mixed,BRepPrimAPI_MakeBox(gp_Pnt(5,0,0),2,2,2).Shape());const auto body=source(mixed);const auto before=brep(mixed);const auto report=DiagnoseMeshShape(mixed,&body,1e-8,true);std::cout<<"mixed "<<JsonSerialize(report)<<std::endl;
  if(!directory.empty()){std::ofstream file(directory/"mixed-report.json");file<<JsonSerialize(report);BRepTools::Write(mixed,(directory/"mixed.brep").string().c_str());STEPControl_Writer writer;require(writer.Transfer(bad,STEPControl_AsIs)==IFSelect_RetDone,"Cannot transfer folded STEP fixture");require(writer.Write((directory/"folded.step").string().c_str())==IFSelect_RetDone,"Cannot write folded STEP fixture");}
  require(report.GetInteger("solidCount")==2&&report.GetBooleanOr("valid",false),"Mixed fixture must retain two valid topology solids");require(selfErrors(report)>0,"Adding a healthy Solid downgraded a real intra-solid self-intersection to warning");
  for(const std::string mode:{"strict","conservative"}){MeshPreparationDiagnostics diagnostics(mode,true);bool blocked=false;try{PrepareConformalMesh({body},"folded-assembly",1,mode,&diagnostics);}catch(const CadError& error){blocked=error.Code()=="MESH_REPAIR_DIAGNOSTIC_FAILED";diagnostics.Failed(error.Code(),error.what());}require(blocked,"Deep preparation did not reject the bad Solid before partitioning");require(brep(mixed)==before,"Mesh preparation changed original source BREP");if(!directory.empty()){std::ofstream file(directory/(mode+"-report.json"));file<<diagnostics.Serialize();}}
  TopoDS_Compound overlaps;builder.MakeCompound(overlaps);builder.Add(overlaps,BRepPrimAPI_MakeBox(2,2,2).Shape());builder.Add(overlaps,BRepPrimAPI_MakeBox(gp_Pnt(1,0,0),2,2,2).Shape());const auto healthyBody=source(overlaps);const auto healthy=DiagnoseMeshShape(overlaps,&healthyBody,1e-8,true);require(selfErrors(healthy)==0,"Legitimate inter-solid overlap was incorrectly rejected as a single-solid defect");MeshPreparationDiagnostics healthyDiagnostics("conservative",true);PrepareConformalMesh({healthyBody},"overlapping-assembly",1,"conservative",&healthyDiagnostics);std::cout<<"per-Solid self-intersection classification preserves valid multi-domain partitioning\n";return 0;
}catch(const Standard_Failure& error){std::cerr<<error.GetMessageString()<<'\n';return 1;}catch(const std::exception& error){std::cerr<<error.what()<<'\n';return 1;}}
