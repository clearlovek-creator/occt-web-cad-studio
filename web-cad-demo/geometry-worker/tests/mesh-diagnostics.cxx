#include "../src/mesh/MeshDiagnostics.hxx"
#include "../src/mesh/MeshPreparation.hxx"
#include "../src/protocol/Json.hxx"
#include "../src/document/CadError.hxx"
#include <BRepPrimAPI_MakeBox.hxx>
#include <BRepBuilderAPI_MakePolygon.hxx>
#include <BRepBuilderAPI_MakeFace.hxx>
#include <BRepBuilderAPI_Copy.hxx>
#include <BRep_Builder.hxx>
#include <BRepTools.hxx>
#include <TopExp.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Edge.hxx>
#include <TopoDS_Shell.hxx>
#include <TopoDS_Compound.hxx>
#include <NCollection_IndexedMap.hxx>
#include <TopTools_ShapeMapHasher.hxx>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <limits>
#include <stdexcept>

using namespace occweb;
using ShapeMap=NCollection_IndexedMap<TopoDS_Shape,TopTools_ShapeMapHasher>;
void require(bool value,const char* message){if(!value)throw std::runtime_error(message);}
MeshPreparationBody source(const TopoDS_Shape& shape,const std::string& kind="solid")
{
  MeshPreparationBody body{"body-1","Corpus",kind,std::string(32,'a'),std::string(32,'b'),1,shape,{}};
  ShapeMap faces;TopExp::MapShapes(shape,TopAbs_FACE,faces);
  for(int i=1;i<=faces.Extent();++i)body.FaceIds.push_back("face-1-"+std::to_string(i));
  return body;
}
int main()
{
  try
  {
    std::string input;std::getline(std::cin,input);
    const auto request=JsonParser(input).Parse();
    const std::filesystem::path directory(request.GetString("directory"));std::filesystem::create_directories(directory);
    auto cases=JsonValue::MakeArray();
    const auto record=[&](const std::string& name,const TopoDS_Shape& shape,const std::string& kind="solid")
    {
      auto body=source(shape,kind);auto entry=JsonValue::MakeObject();entry.ChangeObject()["id"]=JsonValue(name);
      entry.ChangeObject()["diagnostics"]=DiagnoseMeshShape(shape,&body,1e-8,true);
      const std::string file=name+".brep";require(BRepTools::Write(shape,(directory/file).string().c_str()),"Cannot write corpus BREP.");
      entry.ChangeObject()["file"]=JsonValue(file);cases.ChangeArray().push_back(entry);return entry.At("diagnostics");
    };
    const auto box=BRepPrimAPI_MakeBox(10,10,10).Shape();
    const auto healthy=record("healthy-box",box);require(healthy.GetBooleanOr("valid",false)&&healthy.GetInteger("errorCount")==0,"Healthy Box was falsely invalidated.");
    const auto reversed=record("reversed-solid",box.Reversed());require(reversed.GetNumber("signedVolumeSum")<0&&reversed.GetInteger("errorCount")>0,"Reversed Solid was not diagnosed.");
    MeshPreparationDiagnostics finalCheck("strict",false);bool invalidPartitionRejected=false;
    try{finalCheck.Complete(box.Reversed());}catch(const CadError& error){invalidPartitionRejected=error.Code()=="MESH_PARTITION_DIAGNOSTIC_FAILED";}
    require(invalidPartitionRejected&&JsonParser(finalCheck.Serialize()).Parse().GetString("status")=="blocked","Invalid final partition was published as ready.");
    auto highTolerance=BRepBuilderAPI_Copy(box,true,false).Shape();ShapeMap vertices;TopExp::MapShapes(highTolerance,TopAbs_VERTEX,vertices);BRep_Builder builder;builder.UpdateVertex(TopoDS::Vertex(vertices(1)),0.1);
    const auto loose=record("high-tolerance",highTolerance);require(loose.GetNumber("maxTolerance")>=0.1&&loose.GetInteger("warningCount")>0,"Excessive tolerance was not diagnosed.");
    const auto thin=record("small-edges-sliver-faces",BRepPrimAPI_MakeBox(1e-6,10,10).Shape());require(thin.GetInteger("smallEdgeCount")>=4&&thin.GetInteger("sliverFaceCount")>=4,"Small edges and sliver faces were not diagnosed.");
    BRepBuilderAPI_MakePolygon polygon;polygon.Add(gp_Pnt(0,0,0));polygon.Add(gp_Pnt(10,10,0));polygon.Add(gp_Pnt(0,10,0));polygon.Add(gp_Pnt(10,0,0));polygon.Close();
    const auto crossed=record("self-crossing-wire",BRepBuilderAPI_MakeFace(polygon.Wire()).Face(),"sheet");require(!crossed.GetBooleanOr("valid",true)&&crossed.GetInteger("errorCount")>0,"Self-crossing face was not diagnosed.");
    ShapeMap faces;TopExp::MapShapes(box,TopAbs_FACE,faces);TopoDS_Shell openShell;builder.MakeShell(openShell);for(int i=2;i<=faces.Extent();++i)builder.Add(openShell,faces(i));
    const auto open=record("open-shell",openShell,"sheet");require(open.GetInteger("solidCount")==0&&open.GetInteger("openBoundaryEdgeCount")>=4,"Open shell was not diagnosed.");
    auto badParameter=BRepBuilderAPI_Copy(box,true,false).Shape();ShapeMap edges;TopExp::MapShapes(badParameter,TopAbs_EDGE,edges);builder.SameParameter(TopoDS::Edge(edges(1)),false);
    const auto bad=record("missing-same-parameter",badParameter);require(!bad.GetBooleanOr("valid",true),"Invalid SameParameter flag was not diagnosed.");
    auto body=source(badParameter);MeshPreparationDiagnostics report("conservative",true);const auto prepared=PrepareConformalMesh({body},"corpus",1,"conservative",&report);
    const auto repaired=JsonParser(report.Serialize()).Parse();require(repaired.GetString("status")=="ready"&&repaired.At("bodies").AsArray()[0].At("afterRepair").GetInteger("errorCount")==0,"ShapeFix did not repair the malformed edge parameterization.");
    auto repairEntry=JsonValue::MakeObject();repairEntry.ChangeObject()["id"]=JsonValue(std::string("same-parameter-repaired"));repairEntry.ChangeObject()["report"]=repaired;cases.ChangeArray().push_back(repairEntry);
    MeshPreparationDiagnostics strictReport("strict",true);bool rejected=false;try{PrepareConformalMesh({body},"corpus",1,"strict",&strictReport);}catch(const std::exception&){rejected=true;}require(rejected,"Strict preparation accepted an invalid edge flag.");
    BRepBuilderAPI_MakePolygon freeWire;freeWire.Add(gp_Pnt(30,0,0));freeWire.Add(gp_Pnt(40,0,0));
    TopoDS_Compound mixed;builder.MakeCompound(mixed);builder.Add(mixed,box);builder.Add(mixed,freeWire.Wire());
    for(const auto& unsupported:{TopoDS_Shape(freeWire.Wire()),TopoDS_Shape(mixed)})
    {
      MeshPreparationDiagnostics unsupportedReport("strict",false);bool omitted=false;
      try{PrepareConformalMesh({source(unsupported)},"corpus",1,"strict",&unsupportedReport);}catch(const CadError& error){omitted=error.Code()=="MESH_UNSUPPORTED_FREE_TOPOLOGY";}
      require(omitted,"Free Wire geometry was silently omitted from a full-project snapshot.");
    }
    bool nonFiniteRejected=false;try{JsonSerialize(JsonValue(std::numeric_limits<double>::infinity()));}catch(const JsonError&){nonFiniteRejected=true;}require(nonFiniteRejected,"JSON accepted a non-finite diagnostic number.");
    std::ofstream out(directory/"corpus.json",std::ios::binary);out<<JsonSerialize(cases);out.close();require(bool(out),"Cannot write corpus report.");
    std::cout<<"dirty geometry corpus diagnoses defects, preserves warnings and repairs edge flags\n";return 0;
  }
  catch(const std::exception& error){std::cerr<<error.what()<<'\n';return 1;}
}
