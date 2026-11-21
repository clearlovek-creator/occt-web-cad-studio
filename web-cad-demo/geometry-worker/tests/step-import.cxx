#include "../src/document/CadDocument.hxx"
#include "../src/document/CadError.hxx"
#include "../src/exchange/StepImport.hxx"
#include <BRepPrimAPI_MakeBox.hxx>
#include <BRepBuilderAPI_MakeFace.hxx>
#include <BRepBuilderAPI_MakeEdge.hxx>
#include <BRepBuilderAPI_MakeVertex.hxx>
#include <BRep_Builder.hxx>
#include <STEPCAFControl_Writer.hxx>
#include <STEPCAFControl_Reader.hxx>
#include <XCAFApp_Application.hxx>
#include <XCAFDoc_DocumentTool.hxx>
#include <TDocStd_Application.hxx>
#include <TDataStd_Name.hxx>
#include <TDataStd_NamedData.hxx>
#include <TDF_ChildIterator.hxx>
#include <XCAFDoc_ColorTool.hxx>
#include <Interface_Static.hxx>
#include <TopExp_Explorer.hxx>
#include <gp_Trsf.hxx>
#include <TopLoc_Location.hxx>
#include <TopoDS_Compound.hxx>
#include <gp_Pln.hxx>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <stdexcept>
#include <set>

using namespace occweb;
namespace {
void require(bool condition,const char* message){if(!condition)throw std::runtime_error(message);}
template<class Predicate>
std::string selectMeasured(CadDocument& document,const std::string& bodyId,const std::string& kind,const Predicate& predicate){
  const auto presentation=JsonParser(document.BodyPresentation("select",bodyId)).Parse();std::set<std::string> ids;
  if(kind=="face")for(const auto& id:presentation.At("triangleFaceIds").AsArray())ids.insert(id.AsString());
  else for(const auto& edge:presentation.At("edges").AsArray())ids.insert(edge.GetString("edgeId"));
  for(const auto& id:ids)if(predicate(JsonParser(document.Measure("measure",bodyId,kind,id)).Parse()))return id;
  throw std::runtime_error("Required measured topology was not found");
}
void patchNamingFixture(const std::filesystem::path& path,bool legacy,bool inconsistentReplay=false,bool missingSelection=false){
  const auto app=XCAFApp_Application::GetApplication();Handle(TDocStd_Document) document;
  require(app->Open(TCollection_ExtendedString(path.u8string().c_str(),true),document)==PCDM_RS_OK,"Could not open isolated import naming fixture");
  try{
    const auto data=TDataStd_NamedData::Set(document->Main());const auto stored=data->GetString("system.features");
    std::string text(static_cast<std::size_t>(stored.LengthOfCString())+1,'\0');char* bytes=text.data();text.resize(stored.ToUTF8CString(bytes));auto features=JsonParser(text).Parse();
    auto& parameters=features.ChangeArray().front().ChangeObject()["numberParameters"].ChangeObject();
    if(legacy)parameters.erase("importNamingVersion");else parameters["importNamingVersion"]=JsonValue(99.0);
    if(inconsistentReplay){require(features.AsArray().size()>1,"Inconsistent replay fixture requires a transform");features.ChangeArray().back().ChangeObject()["numberParameters"].ChangeObject()["dx"]=JsonValue(200.0);}
    if(missingSelection){auto& strings=features.ChangeArray().back().ChangeObject()["stringParameters"].ChangeObject();strings.erase("selection.edgeId");strings.erase("selection.faceId");}
    data->SetString("system.features",TCollection_ExtendedString(JsonSerialize(features).c_str(),true));
    if(legacy)for(TDF_ChildIterator item(document->Main(),true);item.More();item.Next()){
      Handle(TDataStd_NamedData) body;if(item.Value().FindAttribute(TDataStd_NamedData::GetID(),body)&&body->HasString("system.bodyId"))body->SetString("system.topologyNames.v1",TCollection_ExtendedString("{}"));
    }
    require(app->SaveAs(document,TCollection_ExtendedString(path.u8string().c_str(),true))==PCDM_SS_OK,"Could not save import naming fixture");app->Close(document);
  }catch(...){if(!document.IsNull())app->Close(document);throw;}
}
void writeShape(const std::filesystem::path& path,const TopoDS_Shape& shape){
  const auto app=XCAFApp_Application::GetApplication();Handle(TDocStd_Document) document;app->NewDocument("BinXCAF",document);
  struct Close{Handle(TDocStd_Application) App;Handle(TDocStd_Document) Document;~Close(){App->Close(Document);}} close{app,document};
  XCAFDoc_DocumentTool::SetLengthUnit(document,0.001);
  const auto shapes=XCAFDoc_DocumentTool::ShapeTool(document->Main());const auto colors=XCAFDoc_DocumentTool::ColorTool(document->Main());
  const auto label=shapes->AddShape(shape,false,false);TDataStd_Name::Set(label,TCollection_ExtendedString("Imported mixed product"));colors->SetColor(label,Quantity_Color(Quantity_NOC_BLUE),XCAFDoc_ColorGen);
  TopExp_Explorer face(shape,TopAbs_FACE);if(face.More()){const auto sub=shapes->AddSubShape(label,face.Current());if(!sub.IsNull())colors->SetColor(sub,Quantity_Color(Quantity_NOC_RED),XCAFDoc_ColorSurf);}
  STEPCAFControl_Writer writer;writer.SetNameMode(true);writer.SetColorMode(true);require(writer.Transfer(document,STEPControl_AsIs),"STEP fixture transfer failed");require(writer.Write(path.u8string().c_str())==IFSelect_RetDone,"STEP fixture write failed");
}
void writeStep(const std::filesystem::path& path,const bool mixed){
  BRep_Builder builder;TopoDS_Compound compound;builder.MakeCompound(compound);
  builder.Add(compound,BRepPrimAPI_MakeBox(10,20,30).Shape());builder.Add(compound,BRepPrimAPI_MakeBox(gp_Pnt(40,0,0),5,6,7).Shape());
  if(mixed){builder.Add(compound,BRepBuilderAPI_MakeFace(gp_Pln(gp_Pnt(0,0,50),gp_Dir(0,0,1)),0,10,0,12).Face());builder.Add(compound,BRepBuilderAPI_MakeEdge(gp_Pnt(0,0,70),gp_Pnt(10,0,70)).Edge());builder.Add(compound,BRepBuilderAPI_MakeVertex(gp_Pnt(0,0,90)).Vertex());}
  writeShape(path,compound);
}
void writeLocated(const std::filesystem::path& path){
  const auto shape=BRepPrimAPI_MakeBox(10,20,30).Shape();gp_Trsf occurrence,parent;occurrence.SetTranslation(gp_Vec(40,0,0));parent.SetTranslation(gp_Vec(100,200,300));BRep_Builder builder;TopoDS_Compound compound;builder.MakeCompound(compound);builder.Add(compound,shape);builder.Add(compound,shape.Moved(TopLoc_Location(occurrence)));writeShape(path,compound.Moved(TopLoc_Location(parent)));
}
int rawRedFaces(const std::filesystem::path& path){
  const auto app=XCAFApp_Application::GetApplication();Handle(TDocStd_Document) document;app->NewDocument("BinXCAF",document);struct Close{Handle(TDocStd_Application) App;Handle(TDocStd_Document) Document;~Close(){App->Close(Document);}} close{app,document};STEPCAFControl_Reader reader;reader.SetColorMode(true);require(reader.ReadFile(path.u8string().c_str())==IFSelect_RetDone&&reader.Transfer(document),"Could not inspect STEP fixture colors");const auto colors=XCAFDoc_DocumentTool::ColorTool(document->Main());int count=0;for(TDF_ChildIterator item(document->Main(),true);item.More();item.Next()){Quantity_Color color;const auto shape=XCAFDoc_ShapeTool::GetShape(item.Value());if(!shape.IsNull()&&shape.ShapeType()==TopAbs_FACE&&colors->GetColor(item.Value(),XCAFDoc_ColorSurf,color)&&Quantity_Color::ColorToHex(color)=="#FF0000")count++;}return count;
}
}
int main(int argc,char** argv){
  if(argc==3&&std::string(argv[1])=="--legacy-naming-snapshot"){
    const auto path=std::filesystem::u8path(argv[2]);
    require(path.parent_path().filename().u8string().rfind("cad-legacy-step-",0)==0,"Legacy conversion is test-only and requires a private fixture directory");
    CadDocument initialize("legacy-fixture-formats");patchNamingFixture(path,true);std::cout<<"PASS legacy STEP naming snapshot fixture\n";return 0;
  }
  if(argc==3&&std::string(argv[1])=="--fixture-output"){
    CadDocument initialize("formats");const auto directory=std::filesystem::u8path(argv[2]);std::filesystem::create_directories(directory);writeStep(directory/"solids.step",false);writeStep(directory/"mixed.step",true);writeLocated(directory/"located.step");std::cout<<"PASS STEP source fixtures\n";return 0;
  }
  const auto directory=std::filesystem::temp_directory_path()/std::filesystem::path("cad-step-import-"+std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));std::filesystem::create_directory(directory);
  struct Remove{std::filesystem::path Directory;~Remove(){std::error_code ignored;std::filesystem::remove_all(Directory,ignored);}} remove{directory};
  int failures=0;const auto check=[&](const char* name,const auto& action){try{action();std::cout<<"PASS "<<name<<'\n';}catch(const std::exception& error){failures++;std::cerr<<"FAIL "<<name<<": "<<error.what()<<'\n';}};
  CadDocument initial("initialize-formats");const auto app=XCAFApp_Application::GetApplication();const int owners=app->NbDocuments();
  const auto solids=directory/"solids.step",mixed=directory/"mixed.step",bad=directory/"bad.step";writeStep(solids,false);writeStep(mixed,true);{std::ofstream file(bad);file<<"not a STEP document";}
  check("failed STEP parse preserves live geometry and application ownership",[&]{CadDocument document("atomic");document.CreateBox("box",11,12,13,false);const auto before=document.Summary("same");for(int pass=0;pass<3;pass++){bool rejected=false;try{document.ImportStep("bad",bad.u8string());}catch(const CadError& error){rejected=error.Code()=="STEP_READ_FAILED";}require(rejected,"Bad source was not rejected");require(document.Summary("same")==before,"Failed STEP import destroyed existing geometry");require(app->NbDocuments()==owners+1,"Failed import leaked an XCAF document");}});
  check("mixed topology STEP retains two solids and independent sheet, edge and point",[&]{CadDocument document("mixed");const auto imported=JsonParser(document.ImportStep("import",mixed.u8string())).Parse();require(imported.GetInteger("bodyCount")==5,"Mixed STEP geometry was silently dropped");const auto summary=JsonParser(document.Summary("summary")).Parse();int solids=0,sheets=0,wires=0,other=0;for(const auto& body:summary.At("bodyMetadata").AsArray()){const auto kind=body.GetString("kind");if(kind=="solid")solids++;else if(kind=="sheet")sheets++;else if(kind=="wire")wires++;else other++;}require(solids==2&&sheets==1&&wires==1&&other==1,"Imported body topology classification is incomplete");});
  check("multiple solid import replays on later parameter edits without changing its layout",[&]{
    CadDocument document("replay");document.ImportStep("import",solids.u8string());require(JsonParser(document.Summary("before")).Parse().GetInteger("bodyCount")==2,"Two-solid fixture did not import");
    document.Transform("translate",document.Revision(),"transform.translate","body-1",JsonParser("{\"dx\":2}").Parse());
    document.UpdateFeature("edit",document.Revision(),"feature-2",JsonParser("{\"dx\":4}").Parse());
    require(JsonParser(document.Summary("after")).Parse().GetInteger("bodyCount")==2,"Recompute changed imported body layout");
  });
  check("located occurrences preserve both parent and child placement without deduplicating shared shapes",[&]{
    const auto file=directory/"located.step";writeLocated(file);CadDocument document("located");document.ImportStep("import",file.u8string());const auto summary=JsonParser(document.Summary("same")).Parse();require(summary.GetInteger("bodyCount")==2,"Shared occurrence was deduplicated");const auto& bodies=summary.At("bodyMetadata").AsArray();for(std::size_t index=0;index<2;index++){const auto& min=bodies[index].At("bounds").At("min").AsArray();require(std::abs(min[0].AsNumber()-(100+index*40))<1e-6&&std::abs(min[1].AsNumber()-200)<1e-6&&std::abs(min[2].AsNumber()-300)<1e-6,"Nested placement was lost or applied twice");}
  });
  check("new sources reject byte changes before replay and leave the live model intact",[&]{
    const auto file=directory/"changed.step";std::filesystem::copy_file(solids,file);CadDocument document("fingerprint");document.ImportStep("import",file.u8string());document.Transform("translate",document.Revision(),"transform.translate","body-1",JsonParser("{\"dx\":2}").Parse());const auto before=document.Summary("same");{std::ofstream changed(file,std::ios::app);changed<<'\n';}bool rejected=false;try{document.UpdateFeature("edit",document.Revision(),"feature-2",JsonParser("{\"dx\":4}").Parse());}catch(const CadError& error){rejected=error.Code()=="STEP_REPLAY_SOURCE_CHANGED";}require(rejected,"Changed retained source was accepted");require(document.Summary("same")==before,"Rejected source replacement published partial geometry");
  });
  check("flat export keeps mixed geometry, body names and subshape colors without duplicate original roots",[&]{
    require(rawRedFaces(mixed)>0,"Generated input STEP did not retain its face color");
    CadDocument document("export");document.ImportStep("import",mixed.u8string());const auto file=directory/"roundtrip.step";document.ExportStep("export",file.u8string());Handle(TDocStd_Document) destination;app->NewDocument("BinXCAF",destination);struct Close{Handle(TDocStd_Application) App;Handle(TDocStd_Document) Document;~Close(){App->Close(Document);}} close{app,destination};const auto restored=ReadStepParts(file.u8string(),2,"",destination);require(restored.Parts.size()==5,"Flat export duplicated or dropped imported topology");bool redFace=false;const auto colors=XCAFDoc_DocumentTool::ColorTool(destination->Main());for(const auto& part:restored.Parts){require(!part.Name.empty(),"Imported body name was lost");NCollection_Sequence<TDF_Label> subshapes;XCAFDoc_ShapeTool::GetSubShapes(part.Label,subshapes);for(const auto& sub:subshapes){Quantity_Color color;if(colors->GetColor(sub,XCAFDoc_ColorSurf,color)&&Quantity_Color::ColorToHex(color)=="#FF0000")redFace=true;}}require(redFace,"Imported face color was lost during flattening or export");
  });
  check("legacy decomposition retains its original solid-only layout without silently upgrading old geometry",[&]{const auto legacy=ReadStepParts(mixed.u8string(),1);require(legacy.Parts.size()==2,"Legacy layout changed");for(const auto& part:legacy.Parts)require(part.Shape.ShapeType()==TopAbs_SOLID,"Legacy import gained new topology");});
  check("legacy STEP naming remains explicit and unsupported naming versions reject atomic replay",[&]{
    for(bool legacy:{true,false}){
      const auto snapshot=directory/(legacy?"legacy-naming.xbf":"unsupported-naming.xbf");
      {CadDocument source("naming-fixture");source.ImportStep("import",solids.u8string());source.Transform("move",source.Revision(),"transform.translate","body-1",JsonParser("{\"dx\":2}").Parse());source.SaveSnapshot("save",snapshot.u8string());}
      patchNamingFixture(snapshot,legacy);CadDocument restored("naming-compatibility");restored.RestoreSnapshot("open",snapshot.u8string());const auto before=restored.Summary("same");
      if(legacy){
        const auto changed=JsonParser(restored.UpdateFeature("edit",restored.Revision(),"feature-2",JsonParser("{\"dx\":4}").Parse())).Parse();
        for(const auto& body:changed.At("bodyMetadata").AsArray())require(body.At("topologyNaming").GetInteger("namedFaceCount")==0&&body.At("topologyNaming").GetInteger("namedEdgeCount")==0,"Legacy import names were silently regenerated");
      }else{
        bool rejected=false;try{restored.UpdateFeature("edit",restored.Revision(),"feature-2",JsonParser("{\"dx\":4}").Parse());}catch(const CadError& error){rejected=error.Code()=="STEP_NAMING_VERSION_UNSUPPORTED";}
        require(rejected,"Unknown import naming version was accepted");require(restored.Summary("same")==before,"Rejected naming version mutated the live document");
      }
    }
  });
  const auto legacySnapshot=directory/"upgrade-source.xbf";
  {CadDocument source("legacy-source");source.ImportStep("import",solids.u8string());source.SaveSnapshot("save",legacySnapshot.u8string());}
  patchNamingFixture(legacySnapshot,true);
  check("explicit legacy naming upgrade previews without writes and preserves exact current identities and attributes",[&]{
    CadDocument document("upgrade-fillet");document.RestoreSnapshot("open",legacySnapshot.u8string());
    const auto edge=selectMeasured(document,"body-1","edge",[](const JsonValue& m){return std::abs(m.At("centroid").AsArray()[0].AsNumber())<1e-7&&std::abs(m.At("centroid").AsArray()[1].AsNumber())<1e-7;});
    document.Fillet("fillet",document.Revision(),"body-1",edge,1);
    const auto face=selectMeasured(document,"body-1","face",[](const JsonValue& m){return std::abs(m.GetNumber("area")-15*std::acos(-1.0))<1e-5;});
    document.SetProperty("property",document.Revision(),"face","body-1",face,"marker","int",JsonValue(71.0));
    const auto before=document.Summary("same"),properties=document.ListProperties("same","","","");
    const auto undo=directory/"upgrade-undo.xbf";document.SaveSnapshot("save",undo.u8string());
    for(int pass=0;pass<2;++pass){const auto preview=JsonParser(document.UpgradeImportedNaming("preview",document.Revision(),true)).Parse().At("importedNamingUpgrade");
      require(preview.GetInteger("sourceCount")==1&&preview.GetInteger("referenceCount")==1&&preview.GetBooleanOr("geometryUnchanged",false),"Preview did not verify import plus historical fillet selection");
      require(document.Summary("same")==before&&document.ListProperties("same","","","")==properties,"Preview modified live metadata or attributes");}
    const int revision=document.Revision();const auto upgraded=JsonParser(document.UpgradeImportedNaming("upgrade",revision,false)).Parse();
    require(document.Revision()==revision+1,"Metadata upgrade must be one revision");
    require(upgraded.At("importedNamingUpgrade").GetBooleanOr("changed",false),"Explicit upgrade did not commit");
    const auto original=JsonParser(before).Parse(),after=JsonParser(document.Summary("same")).Parse();
    require(JsonSerialize(original.At("entityIdentities"))==JsonSerialize(after.At("entityIdentities")),"Naming-only upgrade changed persistent topology identities");
    require(JsonSerialize(JsonParser(document.ListProperties("same","","","")).Parse().At("propertyRecords"))==JsonSerialize(JsonParser(properties).Parse().At("propertyRecords")),"Naming-only upgrade changed current property anchors");
    for(const auto& body:after.At("bodyMetadata").AsArray())require(body.At("topologyNaming").GetInteger("namedFaceCount")==body.GetInteger("faceCount"),"Imported output or generated fillet did not receive names");
    require(after.At("features").AsArray().front().At("numberParameters").GetNumber("importNamingVersion")==1,"Import version was not recorded");
    const auto selector=JsonParser(after.At("features").AsArray().back().At("stringParameters").GetString("selection.edgeId")).Parse();require(selector.GetBooleanOr("complete",false),"Historical fillet selector did not get complete names");
    const auto saved=directory/"upgraded-fillet.xbf";document.SaveSnapshot("save",saved.u8string());
    document.UpdateFeature("edit",document.Revision(),"feature-2",JsonParser("{\"radius\":2}").Parse());
    const auto records=JsonParser(document.ListProperties("same","face","body-1","")).Parse().At("propertyRecords");int active=0;
    for(const auto& record:records.AsArray())if(record.GetString("state")=="active"&&record.At("values").Has("marker")){
      ++active;const auto measurement=JsonParser(document.Measure("measure","body-1","face",record.GetString("topologyId"))).Parse();require(std::abs(measurement.GetNumber("area")-30*std::acos(-1.0))<1e-5,"Inherited property selected the wrong generated fillet surface");}
    require(active==1,"Upgraded generated Face property did not survive parameter change");
    document.RestoreSnapshot("undo",undo.u8string());require(document.Summary("same")==before&&document.ListProperties("same","","","")==properties,"Pre-upgrade snapshot did not restore the entire previous state");
    document.RestoreSnapshot("redo",saved.u8string());document.UpdateFeature("edit-again",document.Revision(),"feature-2",JsonParser("{\"radius\":1.5}").Parse());
    const int current=document.Revision();const auto noop=JsonParser(document.UpgradeImportedNaming("noop",current,false)).Parse();require(!noop.At("importedNamingUpgrade").GetBooleanOr("changed",true)&&document.Revision()==current,"Already upgraded project created a spurious mutation");
  });
  check("legacy Face coordinates and dependent geometry are rebound against their exact historical output",[&]{
    CadDocument document("upgrade-coordinates");document.RestoreSnapshot("open",legacySnapshot.u8string());
    document.Transform("move",document.Revision(),"transform.translate","body-1",JsonParser("{\"dx\":2}").Parse());
    const auto face=selectMeasured(document,"body-1","face",[](const JsonValue& m){return std::abs(m.At("centroid").AsArray()[2].AsNumber()-30)<1e-7;});
    auto coordinate=JsonParser("{\"id\":\"import-frame\",\"name\":\"Imported Face\",\"kind\":\"face\",\"referenceBodyId\":\"body-1\"}").Parse();coordinate.ChangeObject()["referenceTopologyId"]=JsonValue(face);
    document.SetCoordinateSystem("coordinate",document.Revision(),coordinate);
    document.CreatePrimitive("dependent","primitive.box",JsonParser("{\"width\":1,\"depth\":2,\"height\":3,\"coordinateSystemId\":\"import-frame\"}").Parse());
    const auto before=JsonParser(document.Summary("same")).Parse();document.UpgradeImportedNaming("upgrade",document.Revision(),false);
    const auto after=JsonParser(document.Summary("same")).Parse();require(JsonSerialize(before.At("coordinateSystems"))==JsonSerialize(after.At("coordinateSystems")),"Metadata upgrade changed the existing coordinate frame");
    const auto changed=JsonParser(document.UpdateFeature("edit",document.Revision(),"feature-2",JsonParser("{\"dx\":12}").Parse())).Parse();
    const auto& coordinates=changed.At("coordinateSystems").AsArray();bool found=false;for(const auto& frame:coordinates)if(frame.GetString("id")=="import-frame"){
      found=true;require(frame.GetString("referenceState")=="resolved","Upgraded coordinate did not resolve after upstream edit");
      require(std::abs(frame.At("origin").AsArray()[0].AsNumber()-17)<1e-7,"Upgraded coordinate bound the wrong Face or occurrence");}
    require(found,"Expected coordinate was lost");
  });
  check("legacy naming upgrade rejects stale revisions and changed sources without partial metadata",[&]{
    const auto file=directory/"upgrade-changed.step",snapshot=directory/"upgrade-changed.xbf";std::filesystem::copy_file(solids,file);
    {CadDocument source("source");source.ImportStep("import",file.u8string());source.SaveSnapshot("save",snapshot.u8string());}patchNamingFixture(snapshot,true);
    CadDocument document("upgrade-failure");document.RestoreSnapshot("open",snapshot.u8string());const auto before=document.Summary("same");
    bool stale=false;try{document.UpgradeImportedNaming("stale",document.Revision()-1,false);}catch(const CadError& error){stale=error.Code()=="STALE_REVISION";}require(stale,"Stale migration was accepted");
    {std::ofstream changed(file,std::ios::app);changed<<'\n';}
    for(bool preview:{true,false}){bool rejected=false;try{document.UpgradeImportedNaming("changed",document.Revision(),preview);}catch(const CadError& error){rejected=error.Code()=="STEP_REPLAY_SOURCE_CHANGED";}
      require(rejected,"Changed retained STEP source was used for naming upgrade");require(document.Summary("same")==before,"Rejected upgrade partially changed document metadata");}
  });
  check("legacy naming upgrade preserves archived recovery evidence by refusing uncertified migration",[&]{
    CadDocument document("upgrade-archive");document.RestoreSnapshot("open",legacySnapshot.u8string());
    const auto patterned=JsonParser(document.Pattern("pattern",document.Revision(),"pattern.linear","body-1",JsonParser("{\"count\":2,\"spacing\":20,\"directionX\":1,\"directionY\":0,\"directionZ\":0}").Parse())).Parse();
    const auto featureId=patterned.At("features").AsArray().back().GetString("id");
    document.ChangeFeatureLifecycle("suppress",document.Revision(),featureId,"feature.suppress");
    document.UpdateFeature("change-dormant",document.Revision(),featureId,JsonParser("{\"spacing\":30}").Parse());const auto before=document.Summary("same");
    bool rejected=false;try{document.UpgradeImportedNaming("upgrade",document.Revision(),false);}catch(const CadError& error){rejected=error.Code()=="IMPORT_NAMING_UPGRADE_ARCHIVE_UNVERIFIED";}
    require(rejected,"Archived recovery evidence was silently invalidated by migration");require(document.Summary("same")==before,"Rejected archived migration changed the model");
  });
  check("legacy archived Pattern topology is re-certified without restoring live geometry or activating orphaned attributes",[&]{
    CadDocument document("upgrade-archive-exact");document.RestoreSnapshot("open",legacySnapshot.u8string());
    const auto patterned=JsonParser(document.Pattern("pattern",document.Revision(),"pattern.linear","body-1",JsonParser("{\"count\":2,\"spacing\":20,\"directionX\":1,\"directionY\":0,\"directionZ\":0}").Parse())).Parse();
    const auto feature=patterned.At("features").AsArray().back();
    const auto featureId=feature.GetString("id"),bodyId=feature.At("outputBodies").AsArray().back().AsString();
    const auto presentation=JsonParser(document.BodyPresentation("view",bodyId)).Parse();
    const auto face=presentation.At("triangleFaceIds").AsArray().front().AsString();
    const auto measured=JsonParser(document.Measure("measure",bodyId,"face",face)).Parse();
    document.SetProperty("marker",document.Revision(),"face",bodyId,face,"archivedMarker","int",JsonValue(73.0));
    document.ChangeFeatureLifecycle("suppress",document.Revision(),featureId,"feature.suppress");
    const auto before=document.Summary("same"),properties=JsonSerialize(JsonParser(document.ListProperties("props","","","")).Parse().At("propertyRecords"));
    const auto preview=JsonParser(document.UpgradeImportedNaming("preview",document.Revision(),true)).Parse();require(preview.At("importedNamingUpgrade").GetInteger("archivedProofCount")>0,"Archive was not verified in preview");require(document.Summary("same")==before,"Archive preview changed the live model");
    document.UpgradeImportedNaming("upgrade",document.Revision(),false);require(JsonSerialize(JsonParser(document.ListProperties("props","","","")).Parse().At("propertyRecords"))==properties,"Migration activated or changed archived properties before feature restoration");
    const auto saved=directory/"archive-upgraded.xbf";document.SaveSnapshot("save",saved.u8string());document.RestoreSnapshot("open-again",saved.u8string());
    document.ChangeFeatureLifecycle("restore",document.Revision(),featureId,"feature.restore");
    auto records=JsonParser(document.ListProperties("props","face",bodyId,"")).Parse().At("propertyRecords");int active=0;
    for(const auto& record:records.AsArray())if(record.GetString("state")=="active"&&record.At("values").Has("archivedMarker")){++active;const auto current=JsonParser(document.Measure("measure",bodyId,"face",record.GetString("topologyId"))).Parse();require(std::abs(current.GetNumber("area")-measured.GetNumber("area"))<1e-7,"Restored archive bound the wrong face");require(JsonSerialize(current.At("centroid"))==JsonSerialize(measured.At("centroid")),"Restored archive moved to another pattern occurrence");}
    require(active==1,"Verified archived Face property was not restored once");
    document.UpdateFeature("edit",document.Revision(),featureId,JsonParser("{\"spacing\":30}").Parse());records=JsonParser(document.ListProperties("props","face",bodyId,"")).Parse().At("propertyRecords");active=0;
    for(const auto& record:records.AsArray())if(record.GetString("state")=="active"&&record.At("values").Has("archivedMarker")){++active;const auto current=JsonParser(document.Measure("measure",bodyId,"face",record.GetString("topologyId"))).Parse();require(std::abs(current.At("centroid").AsArray()[0].AsNumber()-measured.At("centroid").AsArray()[0].AsNumber()-10)<1e-7,"Re-certified property did not follow its own pattern occurrence");}require(active==1,"Re-certified archive did not retain semantic inheritance after editing");
  });
  check("legacy naming upgrade rejects a replay that differs from the exact current BRep",[&]{
    const auto snapshot=directory/"upgrade-inconsistent.xbf";
    {CadDocument source("inconsistent-source");source.ImportStep("import",solids.u8string());source.Transform("move",source.Revision(),"transform.translate","body-1",JsonParser("{\"dx\":2}").Parse());source.SaveSnapshot("save",snapshot.u8string());}
    patchNamingFixture(snapshot,true,true);CadDocument document("upgrade-inconsistent");document.RestoreSnapshot("open",snapshot.u8string());const auto before=document.Summary("same");
    for(bool preview:{true,false}){bool rejected=false;try{document.UpgradeImportedNaming("upgrade",document.Revision(),preview);}catch(const CadError& error){rejected=error.Code()=="IMPORT_NAMING_UPGRADE_GEOMETRY_CHANGED";}
      require(rejected,"Migration trusted feature metadata without verifying the exact current geometry");require(document.Summary("same")==before,"Rejected unequal replay partially committed names");}
  });
  check("legacy naming upgrade never fabricates a missing historical selection from a raw edge number",[&]{
    const auto snapshot=directory/"upgrade-missing-selector.xbf";
    {CadDocument source("missing-source");source.ImportStep("import",solids.u8string());const auto edge=selectMeasured(source,"body-1","edge",[](const JsonValue& m){return std::abs(m.At("centroid").AsArray()[0].AsNumber())<1e-7&&std::abs(m.At("centroid").AsArray()[1].AsNumber())<1e-7;});source.Fillet("fillet",source.Revision(),"body-1",edge,1);source.SaveSnapshot("save",snapshot.u8string());}
    patchNamingFixture(snapshot,true,false,true);CadDocument document("upgrade-missing");document.RestoreSnapshot("open",snapshot.u8string());const auto before=document.Summary("same");
    for(bool preview:{true,false}){bool rejected=false;try{document.UpgradeImportedNaming("upgrade",document.Revision(),preview);}catch(const CadError& error){rejected=error.Code()=="IMPORT_NAMING_UPGRADE_REFERENCE_MISSING";}
      require(rejected,"Undocumented historical Edge index was promoted to a semantic selection");require(document.Summary("same")==before,"Missing reference rejection changed the project");}
  });
  check("STEP file units are normalized to the explicit millimetre model unit",[&]{
    const auto file=directory/"inch.step";const std::string previous=Interface_Static::CVal("write.step.unit");struct Restore{std::string Value;~Restore(){Interface_Static::SetCVal("write.step.unit",Value.c_str());}} restore{previous};Interface_Static::SetCVal("write.step.unit","INCH");writeStep(file,false);CadDocument document("units");const auto imported=JsonParser(document.ImportStep("import",file.u8string())).Parse();require(imported.At("stepImport").GetString("modelLengthUnit")=="mm","Model units not declared");const auto& first=imported.At("bodyMetadata").AsArray().front();const double width=first.At("bounds").At("max").AsArray()[0].AsNumber()-first.At("bounds").At("min").AsArray()[0].AsNumber();require(std::abs(width-10)<1e-5,"STEP inch conversion changed the real model size");
  });
  require(app->NbDocuments()==owners,"STEP test leaked application documents");return failures?1:0;
}
