#include "../src/mesh/MeshPreparation.hxx"
#include "../src/mesh/MeshDiagnostics.hxx"
#include "../src/document/CadError.hxx"
#include "../src/protocol/Json.hxx"
#include <BRepPrimAPI_MakeBox.hxx>
#include <BRepPrimAPI_MakeCylinder.hxx>
#include <BRepAlgoAPI_Cut.hxx>
#include <BRepBuilderAPI_MakeFace.hxx>
#include <BRepBuilderAPI_MakePolygon.hxx>
#include <BRepBuilderAPI_Copy.hxx>
#include <BRepTools.hxx>
#include <BRep_Builder.hxx>
#include <TopExp.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Compound.hxx>
#include <TopoDS_Shell.hxx>
#include <TopTools_IndexedMapOfShape.hxx>
#include <gp_Pln.hxx>
#include <gp_Ax3.hxx>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <map>
#include <stdexcept>
#include <vector>

using namespace occweb;
void require(bool value,const std::string& message){if(!value)throw std::runtime_error(message);}
MeshPreparationBody body(const TopoDS_Shape& shape,int index,const std::string& kind="solid"){
  MeshPreparationBody result{"body-"+std::to_string(index+1),"Industrial "+std::to_string(index+1),kind,std::string(32,char('a'+index)),std::string(32,char('d'+index)),1,shape,{}};
  TopTools_IndexedMapOfShape faces;TopExp::MapShapes(shape,TopAbs_FACE,faces);for(int i=1;i<=faces.Extent();++i)result.FaceIds.push_back("face-1-"+std::to_string(i));return result;
}
int main(){try{
  std::string input;std::getline(std::cin,input);const auto request=JsonParser(input).Parse();const std::filesystem::path root(request.GetString("directory"));std::filesystem::create_directories(root);auto cases=JsonValue::MakeArray();
  const auto box=[](double x,double y,double z,double dx,double dy,double dz){return BRepPrimAPI_MakeBox(gp_Pnt(x,y,z),dx,dy,dz).Shape();};
  const auto record=[&](const std::string& id,std::vector<MeshPreparationBody> bodies,std::map<std::string,double> masses,const std::string& mode="conservative",bool blocked=false){
    auto entry=JsonValue::MakeObject();auto& data=entry.ChangeObject();data["id"]=JsonValue(id);data["mode"]=JsonValue(mode);data["expectedBlocked"]=JsonValue(blocked);auto expected=JsonValue::MakeObject();for(const auto& [key,value]:masses)expected.ChangeObject()[key]=JsonValue(value);data["expectedBodyVolumes"]=expected;
    for(std::size_t i=0;i<bodies.size();++i)require(BRepTools::Write(bodies[i].Shape,(root/(id+"-source-"+std::to_string(i)+"-before.brep")).string().c_str()),"Cannot write source before preparation.");
    MeshPreparationDiagnostics diagnostics(mode,true);
    try{
      const auto prepared=PrepareConformalMesh(bodies,"industrial-corpus",1,mode,&diagnostics);require(!blocked,id+" unexpectedly passed preparation");
      require(BRepTools::Write(prepared.Shape,(root/(id+"-prepared.brep")).string().c_str()),"Cannot write prepared BREP");std::ofstream manifest(root/(id+"-manifest.json"),std::ios::binary);manifest<<prepared.Manifest;manifest.close();require(bool(manifest),"Cannot write preparation manifest");data["prepared"]=JsonValue(true);
    }catch(const CadError& error){diagnostics.Failed(error.Code(),error.what());if(!blocked)throw std::runtime_error(id+": "+error.what());data["prepared"]=JsonValue(false);data["errorCode"]=JsonValue(error.Code());}
    data["diagnostics"]=JsonParser(diagnostics.Serialize()).Parse();data["sourceCount"]=JsonValue(double(bodies.size()));
    for(std::size_t i=0;i<bodies.size();++i)require(BRepTools::Write(bodies[i].Shape,(root/(id+"-source-"+std::to_string(i)+"-after.brep")).string().c_str()),"Cannot write source after preparation");cases.ChangeArray().push_back(entry);
  };
  record("touching-blocks",{body(box(0,0,0,10,10,10),0),body(box(10,0,0,10,10,10),1)},{{"body-1",1000},{"body-2",1000}});
  record("nested-domains",{body(box(0,0,0,10,10,10),0),body(box(4,4,4,2,2,2),1)},{{"body-1",1000},{"body-2",8}});
  BRep_Builder builder;TopoDS_Compound compound;builder.MakeCompound(compound);builder.Add(compound,box(0,0,0,20,10,10));builder.Add(compound,box(10,0,0,20,10,10));
  record("multi-solid-overlap",{body(compound,0)},{{"body-1",3000}});
  record("thin-board-layers",{body(box(0,0,0,20,12,.4),0),body(box(1,1,.4,18,10,.035),1),body(box(-1,-1,-1,22,14,2),2)},{{"body-1",96},{"body-2",6.3},{"body-3",616}});
  const auto horizontal=BRepBuilderAPI_MakeFace(gp_Pln(gp_Ax3(gp_Pnt(0,0,5),gp_Dir(0,0,1),gp_Dir(1,0,0))),1,9,1,9).Face();
  const auto vertical=BRepBuilderAPI_MakeFace(gp_Pln(gp_Ax3(gp_Pnt(5,0,0),gp_Dir(1,0,0),gp_Dir(0,1,0))),1,9,1,9).Face();
  record("crossed-internal-sheets",{body(box(0,0,0,10,10,10),0),body(horizontal,1,"sheet"),body(vertical,2,"sheet")},{{"body-1",1000}});
  record("near-coincident-gap",{body(box(0,0,0,10,10,10),0),body(box(10.00005,0,0,10,10,10),1)},{{"body-1",1000},{"body-2",1000}});
  const auto hole=BRepAlgoAPI_Cut(box(0,0,0,12,10,4),BRepPrimAPI_MakeCylinder(gp_Ax2(gp_Pnt(6,5,0),gp_Dir(0,0,1)),1,4).Shape()).Shape();record("curved-through-hole",{body(hole,0)},{{"body-1",480-4*3.14159265358979323846}});
  const auto healthy=box(0,0,0,10,10,10);auto bad=BRepBuilderAPI_Copy(healthy,true,false).Shape();TopTools_IndexedMapOfShape edges;TopExp::MapShapes(bad,TopAbs_EDGE,edges);builder.SameParameter(TopoDS::Edge(edges(1)),false);
  record("edge-parameter-repaired",{body(bad,0)},{{"body-1",1000}});record("edge-parameter-strict",{body(bad,0)},{},"strict",true);
  record("reversed-solid-repaired",{body(healthy.Reversed(),0)},{{"body-1",1000}});record("reversed-solid-strict",{body(healthy.Reversed(),0)},{},"strict",true);
  TopTools_IndexedMapOfShape faces;TopExp::MapShapes(healthy,TopAbs_FACE,faces);TopoDS_Shell open;builder.MakeShell(open);for(int i=2;i<=faces.Extent();++i)builder.Add(open,faces(i));record("open-shell-blocked",{body(open,0,"sheet")},{},"conservative",true);
  BRepBuilderAPI_MakePolygon polygon;polygon.Add(gp_Pnt(0,0,0));polygon.Add(gp_Pnt(10,10,0));polygon.Add(gp_Pnt(0,10,0));polygon.Add(gp_Pnt(10,0,0));polygon.Close();record("crossed-wire-blocked",{body(BRepBuilderAPI_MakeFace(polygon.Wire()).Face(),0,"sheet")},{},"strict",true);
  std::ofstream index(root/"industrial-corpus.json",std::ios::binary);index<<JsonSerialize(cases);index.close();require(bool(index),"Cannot write corpus index");std::cout<<cases.AsArray().size()<<" representative preprocessing cases generated\n";return 0;
}catch(const Standard_Failure& error){std::cerr<<error.GetMessageString()<<'\n';return 1;}catch(const std::exception& error){std::cerr<<error.what()<<'\n';return 1;}}
