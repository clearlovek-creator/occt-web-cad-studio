#include "../src/exchange/SnapshotSources.hxx"
#include "../src/document/CadDocument.hxx"
#include "../src/protocol/Json.hxx"
#include <XCAFApp_Application.hxx>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <chrono>
#include <stdexcept>
void require(bool value,const char* message){if(!value)throw std::runtime_error(message);}
int main(){
  const auto directory=std::filesystem::temp_directory_path()/std::filesystem::u8path("cad-sources-来源-"+std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));std::filesystem::create_directories(directory);
  try{
    occweb::CadDocument live("sources");live.CreateBox("box",20,30,40,false);const auto source=directory/std::filesystem::u8path("原始.step"),snapshot=directory/std::filesystem::u8path("检查点.xbf");live.ExportStep("export",source.u8string());live.ImportStep("import",source.u8string());live.SaveSnapshot("save",snapshot.u8string());const auto before=live.Summary("same");const auto app=XCAFApp_Application::GetApplication();const int count=app->NbDocuments();
    for(int index=0;index<3;index++){const auto info=occweb::JsonParser(occweb::InspectSnapshotSources(snapshot.u8string())).Parse();require(info.GetBooleanOr("metadataComplete",false),"Native metadata coverage");const auto& entries=info.At("sources").AsArray();require(entries.size()==1,"STEP reference count");require(entries[0].GetString("sourcePath")==source.u8string(),"Unicode source path");require(entries[0].GetString("sourceFingerprintAlgorithm")=="sha256-chain-1m-v1","Source proof");require(entries[0].GetString("sourceFingerprint").size()==64,"Fingerprint length");require(app->NbDocuments()==count,"Inspector leaked registered documents");}
    require(occweb::JsonParser(occweb::InspectSnapshotSources(snapshot.u8string())).Parse().At("sources").AsArray()[0].GetNumber("decompositionVersion")==2,"New source proof requirement version missing");
    std::filesystem::remove(source);require(occweb::JsonParser(occweb::InspectSnapshotSources(snapshot.u8string())).Parse().At("sources").AsArray().size()==1,"Missing sources must not prevent reference inspection");
    const auto bad=directory/"bad.xbf";{std::ofstream file(bad);file<<"not an XBF";}for(int index=0;index<3;index++){bool failed=false;try{occweb::InspectSnapshotSources(bad.u8string());}catch(...){failed=true;}require(failed,"Bad checkpoint accepted");require(app->NbDocuments()==count,"Failed inspection leaked a document");}
    require(live.Summary("same")==before,"Read-only inspection changed the live geometry");std::filesystem::remove_all(directory);std::cout<<"Snapshot source inspection passed\n";return 0;
  }catch(const std::exception& error){std::cerr<<error.what()<<'\n';return 1;}
}
