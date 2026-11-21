#include "SnapshotSources.hxx"
#include "../protocol/Json.hxx"
#include <BinXCAFDrivers.hxx>
#include <PCDM_ReaderStatus.hxx>
#include <TDataStd_NamedData.hxx>
#include <TDocStd_Application.hxx>
#include <TDocStd_Document.hxx>
#include <XCAFApp_Application.hxx>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <vector>
#include <algorithm>

namespace occweb {
std::string InspectSnapshotSources(const std::string& file){
  const auto app=XCAFApp_Application::GetApplication();BinXCAFDrivers::DefineFormat(app);
  struct Cleanup {
    Handle(TDocStd_Application) App;std::vector<Handle(TDocStd_Document)> Before;
    explicit Cleanup(const Handle(TDocStd_Application)& value):App(value){for(int i=1;i<=App->NbDocuments();++i)Before.push_back(App->GetDocument(i));}
    ~Cleanup(){try{for(int i=App->NbDocuments();i>=1;--i){const auto doc=App->GetDocument(i);if(std::find(Before.begin(),Before.end(),doc)==Before.end())App->Close(doc);}}catch(...){}}
  } cleanup(app);
  std::ifstream input(std::filesystem::u8path(file),std::ios::binary);Handle(TDocStd_Document) document;
  if(!input||app->Open(input,document)!=PCDM_RS_OK||document.IsNull())throw std::runtime_error("Could not inspect the independent XBF checkpoint.");
  Handle(TDataStd_NamedData) data;const TCollection_ExtendedString key("system.features");
  if(!document->Main().FindAttribute(TDataStd_NamedData::GetID(),data)||!data->HasString(key))return "{\"ok\":true,\"version\":1,\"metadataComplete\":false,\"sources\":[]}";
  const auto& stored=data->GetString(key);const int length=stored.LengthOfCString();
  if(length<2||length>64*1024*1024)throw std::runtime_error("Checkpoint feature metadata exceeds the inspection budget.");
  std::string text(static_cast<std::size_t>(length)+1,'\0');char* buffer=text.data();const int bytes=stored.ToUTF8CString(buffer);text.resize(static_cast<std::size_t>(bytes));
  const auto features=JsonParser(text).Parse();std::ostringstream out;out<<"{\"ok\":true,\"version\":1,\"metadataComplete\":true,\"sources\":[";int count=0;
  for(const auto& feature:features.AsArray()){
    if(feature.GetString("type")!="import.step")continue;
    if(++count>1000)throw std::runtime_error("Checkpoint STEP reference count exceeds the inspection budget.");
    const auto& parameters=feature.At("stringParameters");if(count>1)out<<',';
    out<<"{\"featureId\":\""<<JsonEscape(feature.GetString("id"))<<"\",\"state\":\""<<JsonEscape(feature.GetStringOr("state","valid"))<<'"';
    if(const auto* numbers=feature.Find("numberParameters"))if(numbers->Has("decompositionVersion"))out<<",\"decompositionVersion\":"<<numbers->GetNumber("decompositionVersion");
    for(const auto* name:{"sourcePath","fileName","sourceFingerprint","sourceFingerprintAlgorithm"})if(parameters.Has(name))out<<",\""<<name<<"\":\""<<JsonEscape(parameters.GetString(name))<<'"';
    out<<'}';
  }
  out<<"]}";return out.str();
}
}
