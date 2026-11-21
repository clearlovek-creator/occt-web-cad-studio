#include "StepImport.hxx"
#include "../document/CadError.hxx"
#include "../document/ShapeFingerprint.hxx"
#include <BRepCheck_Analyzer.hxx>
#include <Standard_OutOfMemory.hxx>
#include <STEPCAFControl_Reader.hxx>
#include <XCAFApp_Application.hxx>
#include <XCAFDoc_DocumentTool.hxx>
#include <XCAFDoc_ShapeTool.hxx>
#include <XCAFDoc_ColorTool.hxx>
#include <XCAFDoc_Editor.hxx>
#include <XCAFDoc_VisMaterial.hxx>
#include <TDataStd_Name.hxx>
#include <TDF_ChildIterator.hxx>
#include <TDocStd_Application.hxx>
#include <NCollection_Sequence.hxx>
#include <TopoDS_Iterator.hxx>
#include <TopExp_Explorer.hxx>
#include <TopExp.hxx>
#include <NCollection_IndexedMap.hxx>
#include <filesystem>
#include <fstream>
#include <utility>
#include <cstdint>
#include <new>
#include <unordered_map>

namespace occweb {
namespace {
std::string sourceFingerprint(const std::filesystem::path& file){
  std::ifstream input(file,std::ios::binary);if(!input)throw CadError("STEP_READ_FAILED","Could not open the STEP source.");
  std::string buffer(1024*1024,'\0'),state="webcad-step-sha256-chain-1m-v1";std::uint64_t total=0,index=0;
  while(input){input.read(buffer.data(),static_cast<std::streamsize>(buffer.size()));const auto count=input.gcount();if(count>0){total+=static_cast<std::uint64_t>(count);state=StableDigest(state+":"+std::to_string(index++)+":"+StableDigest(std::string(buffer.data(),static_cast<std::size_t>(count))));}}
  if(!input.eof())throw CadError("STEP_READ_FAILED","Could not read the complete STEP source.");
  return StableDigest(state+":"+std::to_string(total));
}
std::string nameOf(const TDF_Label& label){
  Handle(TDataStd_Name) attribute;if(label.IsNull()||!label.FindAttribute(TDataStd_Name::GetID(),attribute))return "";
  const auto& value=attribute->Get();std::string result(static_cast<std::size_t>(value.LengthOfCString())+1,'\0');char* bytes=result.data();const int length=value.ToUTF8CString(bytes);result.resize(static_cast<std::size_t>(length));return result;
}
std::vector<TopoDS_Shape> decompose(const TopoDS_Shape& root,const int version){
  if(version==1){std::vector<TopoDS_Shape> solids;for(TopExp_Explorer item(root,TopAbs_SOLID);item.More();item.Next())solids.push_back(item.Current());return solids.size()>1?solids:std::vector<TopoDS_Shape>{root};}
  std::vector<TopoDS_Shape> parts;std::vector<std::pair<TopoDS_Shape,int>> pending{{root,0}};
  while(!pending.empty()){
    const auto [shape,depth]=pending.back();pending.pop_back();if(shape.IsNull())continue;
    if(depth>256||parts.size()+pending.size()>100000)throw CadError("STEP_STRUCTURE_LIMIT","STEP product structure exceeds the supported depth or part count; no geometry was published.");
    if(shape.ShapeType()==TopAbs_COMPOUND||shape.ShapeType()==TopAbs_COMPSOLID){
      // A STEP non-solid product may encode one Wire as a compound of Edges.
      // Keep that product grouping; exploding it breaks existing path selection.
      if(!TopExp_Explorer(shape,TopAbs_SOLID).More()){if(TopoDS_Iterator(shape,true,true).More())parts.push_back(shape);continue;}
      std::vector<TopoDS_Shape> children;for(TopoDS_Iterator item(shape,true,true);item.More();item.Next())children.push_back(item.Value());for(auto item=children.rbegin();item!=children.rend();++item)pending.emplace_back(*item,depth+1);
    }
    else parts.push_back(shape);
  }
  return parts;
}
}

StepImportResult ReadStepParts(const std::string& path,const int version,const std::string& expectedFingerprint,const Handle(TDocStd_Document)& destination){
  if(version!=1&&version!=2)throw CadError("STEP_IMPORT_VERSION_UNSUPPORTED","Unsupported STEP decomposition version.");
  const auto file=std::filesystem::absolute(std::filesystem::u8path(path)).lexically_normal();if(!std::filesystem::is_regular_file(file))throw CadError("STEP_FILE_NOT_FOUND","The STEP source file does not exist.");
  StepImportResult result;
  if(version==2){result.SourceFingerprint=sourceFingerprint(file);if(!expectedFingerprint.empty()&&result.SourceFingerprint!=expectedFingerprint)throw CadError("STEP_REPLAY_SOURCE_CHANGED","The retained STEP source changed; recompute was not applied. Restore the original source or reimport explicitly.");}
  const auto app=XCAFApp_Application::GetApplication();Handle(TDocStd_Document) document;app->NewDocument("BinXCAF",document);if(document.IsNull())throw CadError("STEP_TRANSFER_FAILED","Could not create an isolated STEP import document.");
  struct Close{Handle(TDocStd_Application) App;Handle(TDocStd_Document) Document;~Close(){try{App->Close(Document);}catch(...){}}} close{app,document};
  if(version==2)XCAFDoc_DocumentTool::SetLengthUnit(document,0.001); // Internal coordinates are millimetres.
  STEPCAFControl_Reader reader;reader.SetColorMode(true);reader.SetNameMode(true);reader.SetLayerMode(true);reader.SetPropsMode(true);reader.SetMatMode(true);
  if(reader.ReadFile(file.u8string().c_str())!=IFSelect_RetDone)throw CadError("STEP_READ_FAILED","OCCT could not parse the STEP file.");
  NCollection_Sequence<TCollection_AsciiString> lengths,angles,solidAngles;reader.ChangeReader().FileUnits(lengths,angles,solidAngles);for(const auto& unit:lengths)result.LengthUnits.emplace_back(unit.ToCString());
  if(!reader.Transfer(document))throw CadError("STEP_TRANSFER_FAILED","OCCT could not transfer STEP data into XCAF.");
  const auto shapes=XCAFDoc_DocumentTool::ShapeTool(document->Main());const auto colors=XCAFDoc_DocumentTool::ColorTool(document->Main());NCollection_Sequence<TDF_Label> roots;shapes->GetFreeShapes(roots);result.RootCount=roots.Length();
  const auto destinationShapes=destination.IsNull()?Handle(XCAFDoc_ShapeTool)():XCAFDoc_DocumentTool::ShapeTool(destination->Main());
  NCollection_DataMap<Handle(XCAFDoc_VisMaterial),Handle(XCAFDoc_VisMaterial)> materials;
  using AttributeIndex=std::unordered_map<const TopoDS_TShape*,std::vector<TDF_Label>>;
  NCollection_DataMap<TDF_Label,AttributeIndex> attributeIndexes;
  const auto attributesFor=[&](const TDF_Label& label)->const AttributeIndex& {
    if(!attributeIndexes.IsBound(label)){
      AttributeIndex index;for(TDF_ChildIterator item(label,true);item.More();item.Next()){const auto shape=XCAFDoc_ShapeTool::GetShape(item.Value());if(!shape.IsNull()&&shape.ShapeType()>=TopAbs_FACE)index[shape.TShape().get()].push_back(item.Value());}
      attributeIndexes.Bind(label,std::move(index));
    }
    return attributeIndexes.Find(label);
  };
  for(const auto& root:roots){
    const auto shape=XCAFDoc_ShapeTool::GetShape(root);if(shape.IsNull()){result.EmptyRoots++;continue;}
    const auto parts=decompose(shape,version);if(parts.empty())result.EmptyRoots++;
    for(std::size_t index=0;index<parts.size();index++){
      StepImportedPart part;part.Shape=parts[index];TDF_Label label;shapes->Search(part.Shape,label,true,true,true);part.Name=nameOf(label);if(part.Name.empty())part.Name=nameOf(root)+(parts.size()>1?" ["+std::to_string(index+1)+"]":"");
      if(!label.IsNull())part.HasColor=colors->GetColor(label,XCAFDoc_ColorSurf,part.Color)||colors->GetColor(label,XCAFDoc_ColorGen,part.Color);
      if(!part.HasColor)part.HasColor=colors->GetColor(root,XCAFDoc_ColorSurf,part.Color)||colors->GetColor(root,XCAFDoc_ColorGen,part.Color);
      if(!destinationShapes.IsNull()){
        part.Label=destinationShapes->NewShape();destinationShapes->SetShape(part.Label,part.Shape);
        XCAFDoc_Editor::CloneMetaData(root,part.Label,&materials);
        if(!label.IsNull())XCAFDoc_Editor::CloneMetaData(label,part.Label,&materials);
        TDF_Label definition=label.IsNull()?root:label,referred;if(shapes->GetReferredShape(definition,referred))definition=referred;
        NCollection_IndexedMap<TopoDS_Shape,TopTools_ShapeMapHasher> targets;TopExp::MapShapes(part.Shape,targets);
        std::unordered_map<const TopoDS_TShape*,int> uniqueTargets;
        for(int index=1;index<=targets.Extent();index++){const auto key=targets(index).TShape().get();auto [entry,inserted]=uniqueTargets.emplace(key,index);if(!inserted)entry->second=-1;}
        std::vector<TDF_Label> attributeRoots{root};if(definition!=root)attributeRoots.push_back(definition);
        for(const auto& attributeRoot:attributeRoots){
          const auto& attributes=attributesFor(attributeRoot);
          for(const auto& [key,matched]:uniqueTargets){
            const auto sources=attributes.find(key);if(sources==attributes.end())continue;
            if(matched<1){result.AmbiguousSubshapeMetadata+=static_cast<int>(sources->second.size());continue;}
            const auto target=destinationShapes->AddSubShape(part.Label,targets(matched));
            if(!target.IsNull())for(const auto& source:sources->second)XCAFDoc_Editor::CloneMetaData(source,target,&materials);
          }
        }
      }
      try{part.Valid=BRepCheck_Analyzer(part.Shape).IsValid();}catch(const Standard_OutOfMemory&){throw;}catch(const std::bad_alloc&){throw;}catch(...){part.Valid=false;}
      result.Parts.push_back(std::move(part));
    }
  }
  if(result.Parts.empty())throw CadError("STEP_EMPTY","The STEP file contains no usable shapes.");
  if(version==2&&sourceFingerprint(file)!=result.SourceFingerprint)throw CadError("STEP_SOURCE_CHANGED_DURING_READ","The STEP file changed during transfer; no geometry was published.");
  return result;
}
}
