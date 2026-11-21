#include "../src/document/CadDocument.hxx"
#include "../src/features/LoftBuilder.hxx"
#include "../src/features/PrimitiveBuilder.hxx"
#include "../src/document/CadError.hxx"
#include "../src/document/ShapeFingerprint.hxx"
#include "../src/presentation/ShapeSerializer.hxx"
#include <TDataStd_NamedData.hxx>
#include <TDocStd_Application.hxx>
#include <XCAFApp_Application.hxx>
#include <XCAFDoc_DocumentTool.hxx>
#include <PCDM_ReaderStatus.hxx>
#include <PCDM_StoreStatus.hxx>
#include <filesystem>
#include <iostream>
#include <cmath>
#include <chrono>
#include <algorithm>
#include <TopoDS.hxx>
using namespace occweb;
namespace
{
void require(bool value,const char* message){if(!value)throw std::runtime_error(message);}
void legacyFixture(const std::string& path)
{
  {CadDocument source("legacy-loft");source.CreatePrimitive("a","primitive.box",JsonParser(R"({"width":10,"depth":10,"height":2})").Parse());source.CreatePrimitive("b","primitive.box",JsonParser(R"({"width":20,"depth":8,"height":2,"x":2,"y":2})").Parse());source.SaveSnapshot("save",path);}
  const auto app=XCAFApp_Application::GetApplication();Handle(TDocStd_Document) document;
  require(app->Open(TCollection_ExtendedString(path.c_str(),true),document)==PCDM_RS_OK,"Could not open fixture document");
  try{
    const auto data=TDataStd_NamedData::Set(document->Main());const auto stored=data->GetString("system.features");
    std::string text(static_cast<std::size_t>(stored.LengthOfCString())+1,'\0');char* bytes=text.data();text.resize(stored.ToUTF8CString(bytes));auto features=JsonParser(text).Parse();
    FeatureNode loft;loft.Id="feature-3";loft.Type="detail.loft";loft.InputFeatures={"feature-1","feature-2"};loft.OutputBodies={"body-3"};loft.StringParameters["sectionBodies"]="body-1,body-2";loft.NumberParameters["sectionSpacing"]=12;loft.ComputedRevision=3;
    features.ChangeArray().push_back(JsonParser(loft.ToJson()).Parse());data->SetString("system.features",TCollection_ExtendedString(JsonSerialize(features).c_str(),true));data->SetInteger("system.revision",3);data->SetString("system.activeBody","body-3");
    const auto tool=XCAFDoc_DocumentTool::ShapeTool(document->Main());NCollection_Sequence<TDF_Label> labels;tool->GetFreeShapes(labels);std::vector<TopoDS_Shape> sections;for(int i=1;i<=labels.Length();++i)sections.push_back(tool->GetShape(labels(i)));
    const auto result=BuildLegacyLoft(sections,12);const auto label=tool->AddShape(result,false,false);const auto body=TDataStd_NamedData::Set(label);
    body->SetString("system.bodyId","body-3");body->SetString("system.sourceFeature","feature-3");body->SetInteger("system.topologyRevision",3);body->SetString("system.bodyName","Legacy Loft");body->SetString("system.bodyKind","solid");body->SetInteger("system.bodyVisible",1);
    require(app->SaveAs(document,TCollection_ExtendedString(path.c_str(),true))==PCDM_SS_OK,"Could not save legacy fixture");app->Close(document);
  }catch(...){if(!document.IsNull())app->Close(document);throw;}
}
}
int main(int argc,char** argv){try{
  if(argc==3 && std::string(argv[1])=="--fixture-output"){legacyFixture(argv[2]);std::cout<<"PASS legacy Loft fixture\n";return 0;}
  FeatureNode plane;plane.Id="profile";plane.Type="surface.rectangle";plane.NumberParameters={{"width",10},{"height",10}};const auto built=BuildNamedPrimitive(plane);
  auto invalid=JsonValue::MakeObject();invalid.ChangeObject()["selector"]=JsonValue(TopologyNaming::CaptureSelection(built.Shape,built.Names,"edge",1));invalid.ChangeObject()["bodyIdentity"]=JsonValue(std::string(32,'a'));invalid.ChangeObject()["featureIdentity"]=JsonValue(std::string(32,'b'));
  bool rejected=false;try{ResolveLoftProfile(built.Shape,built.Names,invalid);}catch(const CadError& error){rejected=error.Code()=="INVALID_LOFT_REFERENCE";}require(rejected,"An Edge selector must never reuse its index as a Face");
  plane.Id="profile-b";plane.NumberParameters["z"]=20;const auto last=BuildNamedPrimitive(plane);
  std::vector<LoftProfile> profiles={{TopoDS::Face(ShapeSerializer(built.Shape,0,"").Faces()(1)),built.Names,std::string(64,'a')},{TopoDS::Face(ShapeSerializer(last.Shape,0,"").Faces()(1)),last.Names,std::string(64,'b')}};
  FeatureNode definition;definition.Id="loft";definition.StringParameters={{"loftPlacement","actual"},{"loftRuled","false"}};
  const auto hasRoot=[](const TopologyNames& names,const std::string& root){for(const auto& [key,roots]:names)if(key.rfind("face:",0)==0 && std::find(roots.begin(),roots.end(),root)!=roots.end())return true;return false;};
  const auto oldNames=BuildLoft(profiles,definition).Names;
  require(hasRoot(oldNames,"loft/loft/"+StableDigest("64:"+std::string(64,'a')+"64:"+std::string(64,'b'))+"/start-cap"),"Existing v2 Loft cap names were silently changed");
  definition.StringParameters["loftNamingVersion"]="2";profiles.back().Proof.clear();const auto endpointNames=BuildLoft(profiles,definition).Names;
  require(hasRoot(endpointNames,"loft/loft/section/"+std::string(64,'a')+"/start-cap"),"A cap with its own complete proof was lost due to another unproven section");
  for(const auto& [key,roots]:endpointNames)for(const auto& root:roots)require(root.find("/end-cap")==std::string::npos,"An incomplete end section borrowed another section's proof");
  definition.StringParameters["loftNamingVersion"]="99";rejected=false;try{BuildLoft(profiles,definition);}catch(const CadError& error){rejected=error.Code()=="UNSUPPORTED_LOFT_NAMING_VERSION";}require(rejected,"Unknown Loft naming versions must not be silently reinterpreted");
  const auto path=(std::filesystem::temp_directory_path()/std::filesystem::path("occt-loft-"+std::to_string(std::chrono::steady_clock::now().time_since_epoch().count())+".xbf")).string();
  try{legacyFixture(path);CadDocument document("legacy-loft");document.RestoreSnapshot("open",path);const auto before=JsonParser(document.Summary("summary")).Parse();require(!before.At("features").AsArray().back().At("stringParameters").Has("loftVersion"),"Legacy definition was silently upgraded");
    const auto edited=JsonParser(document.UpdateFeature("edit",3,"feature-1",JsonParser(R"({"width":12})").Parse())).Parse();require(edited.GetInteger("bodyCount")==3,"Legacy Loft body set changed");
    const auto measured=JsonParser(document.Measure("measure","body-3","body","")).Parse();require(std::abs(measured.GetNumber("volume")-1712)<.01,"Legacy bounding-box Loft replay changed its geometry");
    require(!edited.At("features").AsArray().back().At("stringParameters").Has("loftVersion"),"A normal source edit upgraded the legacy Loft");std::filesystem::remove(path);
  }catch(...){std::filesystem::remove(path);throw;}
  std::cout<<"PASS legacy Loft snapshot and upstream replay retain the original version and geometry\n";return 0;
}catch(const std::exception& error){std::cerr<<error.what()<<'\n';return 1;}}
