#include "../src/document/CadDocument.hxx"
#include "../src/document/CadError.hxx"
#include "../src/document/BodyDisplayMetadata.hxx"
#include <XCAFApp_Application.hxx>
#include <XCAFDoc_DocumentTool.hxx>
#include <TDataStd_NamedData.hxx>
#include <PCDM_ReaderStatus.hxx>
#include <PCDM_StoreStatus.hxx>
#include <TDocStd_Application.hxx>
#include <filesystem>
#include <fstream>
#include <chrono>
#include <iostream>
#include <iterator>
#include <stdexcept>
#include <cmath>

using namespace occweb;
void require(bool condition,const char* message){if(!condition)throw std::runtime_error(message);}
int main()
{
  try
  {
    const auto app=XCAFApp_Application::GetApplication();const int baseline=app->NbDocuments();
    const auto directory=std::filesystem::temp_directory_path()/std::filesystem::u8path("cad-document-生命周期-"+std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
    std::filesystem::create_directory(directory);
    struct RemoveFiles{std::filesystem::path Directory;~RemoveFiles(){std::error_code ignored;for(const auto& name:{"original.xbf","bad.xbf","truncated.xbf","display.xbf","legacy-display.xbf","default-display.xbf","bad-display.xbf","foreign-display.xbf","typed-display.xbf"})std::filesystem::remove(Directory/name,ignored);std::filesystem::remove(Directory,ignored);}} remove{directory};
    const auto snapshot=directory/"original.xbf",bad=directory/"bad.xbf",truncated=directory/"truncated.xbf";
    {
      CadDocument first("first");
      for(int pass=0;pass<10;++pass){first.CreateBox("box",20,30,10,false);first.Reset("reset");require(app->NbDocuments()==baseline+1,"Reset leaked an OCCT application document.");}
      first.CreateBox("box",20,30,10,false);first.SaveSnapshot("save",snapshot.u8string());
      const auto saved=JsonParser(first.Summary("same")).Parse();
      first.CreateBox("second",10,10,10,false);
      first.RestoreSnapshot("restore",snapshot.u8string());
      require(first.Revision()==1 && JsonParser(first.Summary("same")).Parse().GetInteger("bodyCount")==1,"Restore did not replace the live state.");
      require(app->NbDocuments()==baseline+1,"Restore leaked its staged or old document.");
      first.SaveSnapshot("save-again",snapshot.u8string());
      {
        CadDocument second("second");second.RestoreSnapshot("same-file",snapshot.u8string());
        require(app->NbDocuments()==baseline+2,"Loading an already-open file must preserve independent document owners.");
        require(JsonParser(second.Summary("same")).Parse().GetString("documentId")=="second","Restore changed the active project identity.");
        const auto before=first.Summary("same");
        {std::ofstream output(bad,std::ios::binary);output<<"not an XBF";}
        {std::ifstream input(snapshot,std::ios::binary);const std::string bytes((std::istreambuf_iterator<char>(input)),{});std::ofstream output(truncated,std::ios::binary);output.write(bytes.data(),static_cast<std::streamsize>(bytes.size()/2));}
        for(const auto& file:{bad,truncated})for(int pass=0;pass<3;++pass){
          bool rejected=false;try{first.RestoreSnapshot("bad",file.u8string());}catch(...){rejected=true;}
          require(rejected,"Corrupt snapshot was accepted.");require(first.Summary("same")==before,"Failed reading destroyed the live project.");require(app->NbDocuments()==baseline+2,"Failed stream reading leaked an application document.");
        }
        const auto bindings=JsonParser("[{\"featureId\":\"missing\",\"path\":\""+JsonEscape(snapshot.u8string())+"\"}]").Parse();
        for(int pass=0;pass<3;++pass){
          bool rejected=false;try{first.RestoreSnapshot("late-failure",snapshot.u8string(),bindings);}catch(const CadError& error){rejected=error.Code()=="INVALID_SOURCE_BINDING";}
          require(rejected,"Invalid retained-source binding was accepted.");require(first.Summary("same")==before,"Late restore validation published partial state.");require(app->NbDocuments()==baseline+2,"Late restore validation leaked a staged document.");
        }
      }
      require(app->NbDocuments()==baseline+1,"Document destruction leaked a registered owner.");
    }
    require(app->NbDocuments()==baseline,"Document scope did not release all OCCT registrations.");
    std::cout<<"PASS resets, shared-file restores, corrupt streams and late validation retain atomic document ownership\n";
    {
      const double value=.3512345678901234;
      const auto display=directory/"display.xbf",legacy=directory/"legacy-display.xbf",defaults=directory/"default-display.xbf",badDisplay=directory/"bad-display.xbf",foreign=directory/"foreign-display.xbf",typed=directory/"typed-display.xbf";
      {CadDocument source("display");source.CreateBox("box",20,30,10,false);source.UpdateBody("display",source.Revision(),"body-1",JsonParser("{\"opacity\":"+FormatBodyOpacity(value)+"}").Parse());source.SaveSnapshot("save",display.u8string());}
      for(int mode=0;mode<5;++mode){
        Handle(TDocStd_Document) stored;require(app->Open(TCollection_ExtendedString(display.u8string().c_str(),true),stored)==PCDM_RS_OK,"Display fixture could not be read.");
        try{
          NCollection_Sequence<TDF_Label> labels;XCAFDoc_DocumentTool::ShapeTool(stored->Main())->GetFreeShapes(labels);require(labels.Length()==1,"Display fixture requires one Body.");
          const auto data=TDataStd_NamedData::Set(labels.First());
          require(data->HasReal("system.bodyOpacity.v1")&&data->GetReal("system.bodyOpacity.v1")==value,"Native snapshot omitted or rounded the actual Body opacity.");
          if(mode!=2){auto reals=data->GetRealsContainer();reals.UnBind("system.bodyOpacity.v1");data->ChangeReals(reals);}
          else data->SetReal("system.bodyOpacity.v1",1.2);
          if(mode==1||mode==3){
            const auto main=TDataStd_NamedData::Set(stored->Main());const auto serialized=main->GetString("system.features");std::string bytes(static_cast<std::size_t>(serialized.LengthOfCString())+1,'\0');char* pointer=bytes.data();bytes.resize(serialized.ToUTF8CString(pointer));auto features=JsonParser(bytes).Parse();
            features.ChangeArray().front().ChangeObject().at("stringParameters").ChangeObject().erase("outputBodyMeta.body-1.opacity");
            if(mode==3)features.ChangeArray().front().ChangeObject().at("stringParameters").ChangeObject()["outputBodyMeta.body-999.opacity"]=JsonValue(FormatBodyOpacity(value));
            main->SetString("system.features",TCollection_ExtendedString(JsonSerialize(features).c_str(),true));
          }
          if(mode==4)data->SetString("system.bodyOpacity.v1","0.35");
          const auto target=mode==0?legacy:mode==1?defaults:mode==2?badDisplay:mode==3?foreign:typed;
          require(app->SaveAs(stored,TCollection_ExtendedString(target.u8string().c_str(),true))==PCDM_SS_OK,"Mutated display fixture could not be saved.");app->Close(stored);
        }catch(...){if(!stored.IsNull())app->Close(stored);throw;}
      }
      CadDocument reopened("display");reopened.RestoreSnapshot("read",display.u8string());
      require(JsonParser(reopened.Summary("state")).Parse().At("bodies").AsArray().front().At("opacity").AsNumber()==value,"Native binary and JSON precision must preserve opacity.");
      reopened.RestoreSnapshot("legacy",legacy.u8string());require(JsonParser(reopened.Summary("state")).Parse().At("bodies").AsArray().front().At("opacity").AsNumber()==value,"Old label-less files must retain exact current-producer display evidence.");
      reopened.RestoreSnapshot("defaults",defaults.u8string());require(JsonParser(reopened.Summary("state")).Parse().At("bodies").AsArray().front().At("opacity").AsNumber()==1.0,"Old files without opacity evidence keep the opaque default.");
      reopened.RestoreSnapshot("foreign",foreign.u8string());require(JsonParser(reopened.Summary("state")).Parse().At("bodies").AsArray().front().At("opacity").AsNumber()==1.0,"A different Body's retained metadata must not authorize legacy opacity recovery.");
      const auto before=reopened.Summary("same");const int owners=app->NbDocuments();
      for(const auto& malformed:{badDisplay,typed}){
        bool refused=false;try{reopened.RestoreSnapshot("bad",malformed.u8string());}catch(const CadError& error){refused=error.Code()=="INVALID_BODY_OPACITY";}
        require(refused&&reopened.Summary("same")==before&&app->NbDocuments()==owners,"Malformed persisted opacity must reject atomically without leaking staged ownership.");
      }
      bool rejectedEdit=false;try{reopened.UpdateBody("bad-edit",reopened.Revision(),"body-1",JsonParser("{\"name\":\"must not change\",\"color\":\"#112233\",\"opacity\":1.2}").Parse());}catch(const CadError& error){rejectedEdit=error.Code()=="INVALID_BODY_OPACITY";}
      require(rejectedEdit&&reopened.Summary("same")==before,"Native invalid display edits must not partially change name, color, metadata or revision.");
      FeatureNode feature;
      for(const double scalar:{.05,value,1.0}){feature.StringParameters["outputBodyMeta.body-1.opacity"]=FormatBodyOpacity(scalar);require(StoredBodyOpacity(feature,"outputBodyMeta","body-1")==scalar,"Lossless stored opacity roundtrip failed.");}
      for(const std::string invalid:std::vector<std::string>{"1.2","0.01","null","garbage","0.35 trailing",std::string(65,'1')}){
        feature.StringParameters["outputBodyMeta.body-1.opacity"]=invalid;bool rejected=false;try{StoredBodyOpacity(feature,"outputBodyMeta","body-1");}catch(const CadError& error){rejected=error.Code()=="INVALID_BODY_OPACITY";}require(rejected,"Malformed or out-of-range stored opacity must not be clamped or guessed.");
      }
    }
    require(app->NbDocuments()==baseline,"Display persistence checks leaked an OCCT document owner.");
    std::cout<<"PASS native Body opacity is lossless, legacy evidence is retained, missing evidence defaults and corrupt display snapshots fail atomically\n";
    return 0;
  }
  catch(const std::exception& error){std::cerr<<error.what()<<'\n';return 1;}
}
