#include "../src/mesh/DiscreteSurfaceExport.hxx"
#include "../src/document/CadDocument.hxx"
#include "../src/document/CadError.hxx"
#include "../src/document/ShapeFingerprint.hxx"
#include <BRepPrimAPI_MakeBox.hxx>
#include <BRepPrimAPI_MakeCylinder.hxx>
#include <BRepBuilderAPI_MakeFace.hxx>
#include <BRepBuilderAPI_MakeEdge.hxx>
#include <BRepMesh_IncrementalMesh.hxx>
#include <BRepTools.hxx>
#include <BRep_Tool.hxx>
#include <BRep_Builder.hxx>
#include <BOPAlgo_Splitter.hxx>
#include <TopExp.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Compound.hxx>
#include <TopTools_IndexedMapOfShape.hxx>
#include <gp_Pln.hxx>
#include <iostream>
#include <sstream>
#include <set>
#include <functional>
using namespace occweb;
namespace {
void require(bool value,const char* message){if(!value)throw std::runtime_error(message);}
MeshPreparationBody source(const TopoDS_Shape& shape,int index=1,int revision=7){MeshPreparationBody body{"body-"+std::to_string(index),"Source","solid",std::string(32,char('a'+index)),std::string(32,char('1'+index)),revision,shape,{}};TopTools_IndexedMapOfShape faces;TopExp::MapShapes(shape,TopAbs_FACE,faces);for(int i=1;i<=faces.Extent();i++)body.FaceIds.push_back("face-"+std::to_string(revision)+'-'+std::to_string(i));return body;}
JsonValue options(const std::string& text="{}"){return JsonParser(text).Parse();}
JsonValue exportSource(const std::vector<MeshPreparationBody>& bodies,const JsonValue& p=options()){return ExportDiscreteSurfaceSource(bodies,"source-test",50,p);}
void reject(const std::function<void()>& action,const std::string& code){try{action();}catch(const CadError& e){require(e.Code()==code,("Wrong rejection: "+e.Code()+" expected "+code).c_str());return;}throw std::runtime_error("Expected rejection "+code);}
std::string brep(const TopoDS_Shape& shape){std::ostringstream out;BRepTools::Write(shape,out);return out.str();}
TopoDS_Compound compound(const std::vector<TopoDS_Shape>& shapes){BRep_Builder builder;TopoDS_Compound root;builder.MakeCompound(root);for(const auto& shape:shapes)builder.Add(root,shape);return root;}
std::size_t count(const JsonValue& bundle){return bundle.At("input").At("triangles").AsArray().size();}
void check(const JsonValue& bundle){
  require(bundle.GetInteger("version")==1&&bundle.At("report").GetBooleanOr("complete",false),"Incomplete source bundle");const auto& input=bundle.At("input");require(input.At("sources").AsArray().size()==count(bundle),"Incomplete per-triangle source map");
  require(bundle.At("report").GetInteger("triangleCount")==int(count(bundle)),"Contradictory triangle count");require(!bundle.At("report").GetBooleanOr("tetrahedralReady",true),"Surface export claimed a tetrahedral domain");
  std::size_t cursor=0;for(const auto& face:bundle.At("inventory").At("faces").AsArray()){
    require(face.GetInteger("triangleStart")==int(cursor),"Noncontiguous face range");std::size_t faceCount=0;
    for(const auto& use:face.At("uses").AsArray()){
      require(use.GetInteger("triangleStart")==int(cursor),"Noncontiguous face use range");const auto n=use.GetInteger("triangleCount");require(n>0,"Unmeshed face use");for(int i=0;i<n;i++){
        const auto& owner=input.At("sources").AsArray()[cursor+i];require(owner.GetString("bodyId")==face.GetString("bodyId")&&owner.GetString("faceId")==face.GetString("faceId"),"Wrong body/face source");require(owner.GetStringOr("solidId","")==use.GetString("solidId"),"Wrong solid source");
      }cursor+=n;faceCount+=n;
    }require(face.GetInteger("triangleCount")==int(faceCount),"Incomplete face range");
  }require(cursor==count(bundle),"Triangles outside source inventory");
}
}
int main(){try{
  const auto box=BRepPrimAPI_MakeBox(2,3,4).Shape();const auto body=source(box);const auto original=brep(box),hash=ShapeFingerprint(box);const auto clean=exportSource({body});check(clean);require(count(clean)==12,"Box source is not twelve triangles");require(clean.At("inventory").At("faces").AsArray().size()==6&&clean.At("inventory").At("solids").AsArray().size()==1,"Box inventory incomplete");require(original==brep(box)&&hash==ShapeFingerprint(box),"Export changed live BREP or geometry");
  TopTools_IndexedMapOfShape faces;TopExp::MapShapes(box,TopAbs_FACE,faces);for(int i=1;i<=faces.Extent();i++){TopLoc_Location location;require(BRep_Tool::Triangulation(TopoDS::Face(faces(i)),location).IsNull(),"Export tessellated a live CAD face");}std::cout<<"PASS complete box source and untouched original topology\n";
  const auto cylinder=BRepPrimAPI_MakeCylinder(5,10).Shape();BRepMesh_IncrementalMesh display(cylinder,1,false,0.8,false);const auto cached=brep(cylinder);const auto coarse=exportSource({source(cylinder)},options("{\"linearDeflection\":0.5,\"angularDeflection\":0.5}"));const auto fine=exportSource({source(cylinder)},options("{\"linearDeflection\":0.01,\"angularDeflection\":0.05}"));check(fine);require(count(fine)>count(coarse),"Dedicated policy reused the display mesh");require(cached==brep(cylinder),"Dedicated export replaced a live display cache");std::cout<<"PASS explicit curved-surface policy and display-cache isolation\n";
  const auto second=BRepPrimAPI_MakeBox(gp_Pnt(1,0,0),2,3,4).Shape();const auto overlap=exportSource({body,source(second,2)});check(overlap);require(count(overlap)==24&&overlap.At("inventory").At("solids").AsArray().size()==2,"Raw source performed unintended Boolean partitioning");std::cout<<"PASS all overlapping Bodies retain original Solid ownership\n";
  const auto multi=exportSource({source(compound({box,second}))});check(multi);require(count(multi)==24&&multi.At("source").At("bodies").AsArray().size()==1&&multi.At("inventory").At("solids").AsArray().size()==2,"Multi-Solid Body lost ownership");std::cout<<"PASS one Body with multiple original Solids\n";
  BOPAlgo_Splitter split;split.AddArgument(box);split.AddArgument(BRepPrimAPI_MakeBox(gp_Pnt(2,0,0),2,3,4).Shape());split.SetNonDestructive(true);split.Perform();require(!split.HasErrors(),"Cannot create shared-face fixture");const auto shared=exportSource({source(split.Shape())});check(shared);int sharedFaces=0;for(const auto& face:shared.At("inventory").At("faces").AsArray())if(face.At("uses").AsArray().size()==2){sharedFaces++;std::set<std::string> directions;for(const auto& use:face.At("uses").AsArray())directions.insert(use.GetString("orientation"));require(directions.size()==2,"Shared face lost opposite solid-use directions");}require(sharedFaces==1,"Shared original face was not represented once with two uses");std::cout<<"PASS shared Face retains both Solid uses and orientation\n";
  auto sheet=source(BRepBuilderAPI_MakeFace(gp_Pln(gp_Pnt(0,0,0),gp_Dir(0,0,1)),0,2,0,3).Shape());sheet.Kind="sheet";const auto surface=exportSource({sheet});check(surface);require(surface.At("inventory").At("solids").AsArray().empty()&&count(surface)==2,"Open Sheet was converted into a fake closed Solid");for(const auto& owner:surface.At("input").At("sources").AsArray())require(!owner.Has("solidId"),"Free face was assigned a Solid");std::cout<<"PASS free Sheet remains surface-only\n";
  const auto edge=BRepBuilderAPI_MakeEdge(gp_Pnt(10,0,0),gp_Pnt(11,0,0)).Shape();const auto withWire=source(compound({box,edge}));const auto beforeReject=brep(box);reject([&]{exportSource({withWire});},"SURFACE_EXPORT_UNSUPPORTED_FREE_TOPOLOGY");reject([&]{exportSource({body},options("{\"maxTriangles\":1}"));},"SURFACE_EXPORT_TRIANGLE_LIMIT");require(beforeReject==brep(box),"Rejected export changed live geometry");std::cout<<"PASS free topology and insufficient budget reject without truncation\n";
  for(const auto& invalid:{"{\"selection\":\"body-1\"}","{\"maxTriangles\":1.5}","{\"linearDeflection\":0}","{\"angularDeflection\":1}","{\"maxTriangles\":20001}"})reject([&]{exportSource({body},options(invalid));},"SURFACE_EXPORT_OPTIONS_INVALID");auto bad=body;bad.FaceIds[0]="face-50-1";reject([&]{exportSource({bad});},"SURFACE_EXPORT_SOURCE_INVALID");std::cout<<"PASS options and source index mismatch reject\n";
  CadDocument document("native-source");document.CreatePrimitive("create","primitive.box",options("{\"width\":2,\"depth\":3,\"height\":4}"));const auto before=JsonParser(document.Summary("same")).Parse();const auto response=JsonParser(document.ExportDiscreteSurface("export",options())).Parse();require(response.At("discreteSurface").At("source").GetInteger("revision")==document.Revision(),"Export is not bound to document revision");require(JsonSerialize(before)==JsonSerialize(JsonParser(document.Summary("same")).Parse()),"Read-only document export changed model state");std::cout<<"PASS document source revision and readonly state\n";return 0;
}catch(const Standard_Failure& e){std::cerr<<e.GetMessageString()<<'\n';return 1;}catch(const std::exception& e){std::cerr<<e.what()<<'\n';return 1;}}
