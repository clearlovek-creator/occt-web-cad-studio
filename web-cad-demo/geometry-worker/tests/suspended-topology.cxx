#include "../src/document/SuspendedTopology.hxx"
#include "../src/document/CadError.hxx"
#include "../src/document/UserPropertyStore.hxx"
#include "../src/document/CadDocument.hxx"
#include "../src/features/PrimitiveBuilder.hxx"
#include "../src/features/FeatureNode.hxx"
#include "../src/presentation/ShapeSerializer.hxx"
#include <BRep_Builder.hxx>
#include <TopoDS_Compound.hxx>
#include <iostream>
#include <stdexcept>
#include <TDataStd_NamedData.hxx>
#include <TDocStd_Application.hxx>
#include <XCAFApp_Application.hxx>
#include <PCDM_ReaderStatus.hxx>
#include <PCDM_StoreStatus.hxx>
#include <filesystem>
#include <chrono>

using namespace occweb;
void require(bool ok,const std::string& why){if(!ok)throw std::runtime_error(why);}
template<class F>void rejects(F action){bool rejected=false;try{action();}catch(const CadError& error){rejected=error.Code()=="INVALID_SUSPENDED_TOPOLOGY";}require(rejected,"Invalid evidence must be rejected explicitly");}
void storedRecoveryBoundary(bool legacy)
{
  const auto path=std::filesystem::temp_directory_path()/("occt-suspended-proof-"+std::to_string(std::chrono::steady_clock::now().time_since_epoch().count())+".xbf");
  struct Cleanup {std::filesystem::path Path;~Cleanup(){std::error_code ignored;std::filesystem::remove(Path,ignored);}}cleanup{path};
  std::string featureId,bodyId;
  {
    CadDocument source("recovery-boundary");source.CreateBox("box",10,8,6,false);
    const auto pattern=JsonParser(source.Pattern("pattern",source.Revision(),"pattern.linear","body-1",JsonParser(R"({"count":2,"spacing":20,"directionX":1,"directionY":0,"directionZ":0})").Parse())).Parse();
    const auto& definition=pattern.At("features").AsArray().back();featureId=definition.GetString("id");bodyId=definition.At("outputBodies").AsArray().back().AsString();
    const auto view=JsonParser(source.BodyPresentation("presentation",bodyId)).Parse();
    source.SetProperty("property",source.Revision(),"face",bodyId,view.At("triangleFaceIds").AsArray().front().AsString(),"marker","int",JsonValue(7.0));
    source.ChangeFeatureLifecycle("suppress",source.Revision(),featureId,"feature.suppress");source.SaveSnapshot("save",path.u8string());
  }
  const auto app=XCAFApp_Application::GetApplication();Handle(TDocStd_Document) document;
  require(app->Open(TCollection_ExtendedString(path.u8string().c_str(),true),document)==PCDM_RS_OK,"Could not open isolated recovery fixture");
  try{
    const auto data=TDataStd_NamedData::Set(document->Main());const auto stored=data->GetString("system.features");
    std::string text(static_cast<std::size_t>(stored.LengthOfCString())+1,'\0');char* bytes=text.data();text.resize(stored.ToUTF8CString(bytes));auto definitions=JsonParser(text).Parse();
    auto& definition=definitions.ChangeArray().back();require(definition.Has("suspendedTopology"),"Fixture must contain real captured recovery evidence");
    if(legacy)definition.ChangeObject().erase("suspendedTopology");
    else definition.ChangeObject()["suspendedTopology"].ChangeObject()[bodyId].ChangeObject()["version"]=JsonValue(99.0);
    data->SetString("system.features",TCollection_ExtendedString(JsonSerialize(definitions).c_str(),true));
    require(app->SaveAs(document,TCollection_ExtendedString(path.u8string().c_str(),true))==PCDM_SS_OK,"Could not save isolated recovery fixture");app->Close(document);
  }catch(...){if(!document.IsNull())app->Close(document);throw;}
  CadDocument restored("recovery-boundary");restored.RestoreSnapshot("open",path.u8string());const auto before=restored.Summary("same");
  if(!legacy){
    rejects([&]{restored.ChangeFeatureLifecycle("restore",restored.Revision(),featureId,"feature.restore");});
    require(restored.Summary("same")==before,"Bad recovery evidence must fail before changing live revision, features, Bodies, identities or properties");
  }else{
    const auto result=JsonParser(restored.ChangeFeatureLifecycle("restore",restored.Revision(),featureId,"feature.restore")).Parse();require(result.GetInteger("bodyCount")==2,"Legacy geometry should restore without invented attribute evidence");
    const auto records=JsonParser(restored.ListProperties("properties","",bodyId,"")).Parse();
    for(const auto& record:records.At("propertyRecords").AsArray())require(record.GetString("state")!="active","An old suppressed file without proof must not reactivate its orphaned Face property");
  }
}
int main(){try{
  FeatureNode feature;feature.Id="box-source";feature.Type="primitive.box";feature.NumberParameters={{"width",20},{"depth",30},{"height",40}};
  const auto original=BuildNamedPrimitive(feature);ShapeSerializer topology(original.Shape,0,"");
  const auto set=TopologyNaming::CaptureSelectionSet(original.Shape,original.Names);
  for(const std::string kind:{"face","edge"})for(int i=1;i<=(kind=="face"?topology.Faces().Extent():topology.Edges().Extent());++i){
    const auto single=JsonParser(TopologyNaming::CaptureSelection(original.Shape,original.Names,kind,i)).Parse();
    const auto& entry=set.At("entries").At(kind+':'+std::to_string(i));
    for(const std::string field:{"complete","origins","originCount","neighborhoodCount","neighborhood"})
      require(JsonSerialize(entry.At(field))==JsonSerialize(single.At(field)),"Bulk proof must agree with the established single-selection resolver");
  }
  std::cout<<"PASS bulk proof agrees with all single Face/Edge selections\n";
  TopoDS_Compound reordered;BRep_Builder builder;builder.MakeCompound(reordered);
  for(int i=topology.Faces().Extent();i>=1;--i)builder.Add(reordered,topology.Faces()(i));
  ShapeSerializer current(reordered,0,"");TopologyNames names;
  for(const std::string kind:{"face","edge"}){
    const auto& oldMap=kind=="face"?topology.Faces():topology.Edges();const auto& newMap=kind=="face"?current.Faces():current.Edges();
    for(int i=1;i<=newMap.Extent();++i)names[kind+':'+std::to_string(i)]=original.Names.at(kind+':'+std::to_string(oldMap.FindIndex(newMap(i))));
  }
  const auto mapped=TopologyNaming::ResolveSelectionSet(reordered,names,set,3,5);
  for(const std::string kind:{"face","edge"}){
    const auto& oldMap=kind=="face"?topology.Faces():topology.Edges();const auto& newMap=kind=="face"?current.Faces():current.Edges();
    for(int i=1;i<=oldMap.Extent();++i)require(mapped.at(kind+"-3-"+std::to_string(i))==std::vector<std::string>{kind+"-5-"+std::to_string(newMap.FindIndex(oldMap(i)))},"Reordered topology must preserve the physical Face/Edge, not its index");
  }
  std::cout<<"PASS bulk recovery follows real reordered topology\n";
  const auto unnamed=TopologyNaming::CaptureSelectionSet(original.Shape,{});
  const auto same=TopologyNaming::ResolveSelectionSet(original.Shape,{},unnamed,3,5);
  for(const auto& [source,targets]:same)require(targets.size()==1,"Exact unchanged BRep permits verified enumeration");
  const auto changed=TopologyNaming::ResolveSelectionSet(reordered,{},unnamed,3,5);
  for(const auto& [source,targets]:changed)require(targets.empty(),"Changed unnamed input must not use enumeration");
  auto partial=original.Names;partial.erase("face:1");
  const auto incomplete=TopologyNaming::CaptureSelectionSet(original.Shape,partial);
  require(!incomplete.At("entries").At("edge:1").At("complete").AsBoolean(),"Fixture must include an incomplete edge neighborhood");
  require(TopologyNaming::ResolveSelectionSet(reordered,names,incomplete,3,5).at("edge-3-1").empty(),"Incomplete old evidence cannot become proven after recovery");
  auto ambiguous=original.Names;for(auto& [key,roots]:ambiguous)roots={key.rfind("face:",0)==0?"duplicate-face":"duplicate-edge"};
  const auto duplicates=TopologyNaming::CaptureSelectionSet(original.Shape,ambiguous);
  TopologyNames duplicateNext;for(const auto& [key,roots]:names)duplicateNext[key]={key.rfind("face:",0)==0?"duplicate-face":"duplicate-edge"};
  for(const auto& [source,targets]:TopologyNaming::ResolveSelectionSet(reordered,duplicateNext,duplicates,3,5))require(targets.empty(),"Symmetric repeated proofs must never choose the first result");
  std::cout<<"PASS missing and ambiguous provenance remains unresolved\n";
  auto bad=set;bad.ChangeObject()["version"]=JsonValue(2.0);rejects([&]{TopologyNaming::ResolveSelectionSet(original.Shape,original.Names,bad,3,5);});
  bad=set;bad.ChangeObject()["entries"].ChangeObject().erase("face:1");rejects([&]{TopologyNaming::ResolveSelectionSet(original.Shape,original.Names,bad,3,5);});
  bad=set;bad.ChangeObject()["entries"].ChangeObject()["edge:1"].ChangeObject()["neighborhoodCount"]=JsonValue(999.0);rejects([&]{TopologyNaming::ResolveSelectionSet(original.Shape,original.Names,bad,3,5);});
  SuspendedTopologyIdentity identity{"body-1","body-uuid","topology-uuid","source","source-uuid",3,SuspendedDefinitionFingerprint(feature)};
  const auto proof=CaptureSuspendedTopology(original.Shape,original.Names,identity);
  require(ResolveSuspendedTopology(reordered,names,proof,identity,5).Verified,"Matching persistent ownership must verify");
  for(int field=0;field<4;++field){auto other=identity;if(field==0)other.BodyId="body-2";if(field==1)other.BodyIdentity="other-uuid";if(field==2)other.SourceFeatureId="other-source";if(field==3)other.SourceFeatureIdentity="other-source-uuid";require(!ResolveSuspendedTopology(original.Shape,original.Names,proof,other,5).Verified,"Reused IDs or different creators must not inherit properties");}
  rejects([&]{ResolveSuspendedTopology(original.Shape,original.Names,"{\"version\":2}",identity,5);});
  auto replacedNames=original.Names;for(auto& [key,roots]:replacedNames)roots={"replacement/"+key};
  for(const auto& [source,targets]:TopologyNaming::ResolveSelectionSet(original.Shape,replacedNames,set,3,5))require(targets.empty(),"Identical BRep with replaced generation identities is not the same selection");
  replacedNames["face:1"]=original.Names.at("face:1");
  require(TopologyNaming::ResolveSelectionSet(original.Shape,replacedNames,set,3,5).at("face-3-1")==std::vector<std::string>{"face-5-1"},"An unchanged unique constructor role survives replacement of its adjacent roles");
  auto incompleteCurrent=original.Names;incompleteCurrent.erase("face:1");
  require(TopologyNaming::ResolveSelectionSet(original.Shape,incompleteCurrent,set,3,5).at("edge-3-1").empty(),"Incomplete current provenance must not create a unique primary match");
  const auto unnamedProof=CaptureSuspendedTopology(original.Shape,{},identity);auto changedDefinition=identity;changedDefinition.DefinitionFingerprint=std::string(64,'a');
  for(const auto& [source,targets]:ResolveSuspendedTopology(original.Shape,{},unnamedProof,changedDefinition,5).Mapping)require(targets.empty(),"Unnamed exact geometry must not override a changed generating definition");
  std::cout<<"PASS envelope versions, completeness, multiplicity and ownership are checked\n";
  feature.SuspendedTopology["body-1"]=proof;
  require(!JsonParser(feature.ToJson()).Parse().Has("suspendedTopology"),"Public responses must not expose bulk recovery evidence");
  const auto restored=FeatureNode::FromJson(JsonParser(feature.ToJson(true)).Parse());
  require(restored.SuspendedTopology.at("body-1")==proof,"Private evidence must round-trip through stored features");
  UserPropertyStore properties;properties.Set("face","body-1","face-3-1","marker","int",JsonValue(7.0));properties.Set("edge","body-1","edge-2-1","unrelated","bool",JsonValue(true));properties.OrphanBody("body-1","suppressed");
  properties.RemapTopology("body-1","body-1",{{"face-3-1",{"face-5-2"}}},"verified recovery",true);
  const auto values=JsonParser(properties.ToJson()).Parse();bool recovered=false,unrelated=false;
  for(const auto& record:values.AsArray()){if(record.GetString("topologyId")=="face-5-2")recovered=record.GetString("state")=="active";if(record.GetString("topologyId")=="edge-2-1")unrelated=record.GetString("state")=="orphaned";}
  require(recovered&&unrelated,"Only an explicitly proven orphan may recover");
  std::cout<<"PASS private persistence and proven raw-property recovery\n";
  {
    auto source=feature;source.Identity="recertified-source-uuid";source.SuspendedTopology.clear();
    SuspendedTopologyIdentity archived{"archived-body","archived-body-uuid","old-topology-uuid",source.Id,source.Identity,3,SuspendedDefinitionFingerprint(source)};
    const auto legacy=CaptureSuspendedTopology(original.Shape,{},archived);
    const auto migrated=RecertifySuspendedTopology(legacy,original.Shape,{},original.Shape,original.Names,source,source,archived.BodyId,archived.BodyIdentity,5);
    const auto record=JsonParser(migrated).Parse();require(record.GetInteger("version")==2,"Re-certified archive must have explicit versioned stable definitions");
    require(JsonSerialize(record.At("priorNamingProof"))==JsonSerialize(JsonParser(legacy).Parse()),"Migration must retain the complete original proof");
    require(record.GetString("topologyIdentity")==archived.TopologyIdentity&&record.GetInteger("revision")==archived.Revision,"Re-certification must not change original attribute ownership");
    auto current=archived;current.StableDefinitionFingerprint=StableSuspendedDefinitionFingerprint(source);
    const auto recovered=ResolveSuspendedTopology(reordered,names,migrated,current,6);require(recovered.Verified,"Re-certified archive ownership was lost");
    for(const auto& [unused,targets]:recovered.Mapping)require(targets.size()==1,"Re-certified semantic proof must survive actual topology reordering");
    for(int invalid=0;invalid<4;++invalid){bool refused=false;auto wrong=source;if(invalid==0)wrong.NumberParameters["width"]=21;if(invalid==1)wrong.Identity="another-source";
      try{RecertifySuspendedTopology(legacy,invalid==2?reordered:original.Shape,{},original.Shape,original.Names,wrong,source,archived.BodyId,invalid==3?"another-body":archived.BodyIdentity,5);}catch(const CadError& error){refused=error.Code()=="IMPORT_NAMING_UPGRADE_ARCHIVE_UNVERIFIED";}require(refused,"Changed archived geometry, definition or ownership was re-certified");}
    auto corrupted=record;corrupted.ChangeObject()["priorNamingProof"].ChangeObject()["bodyId"]=JsonValue(std::string("tampered"));rejects([&]{ResolveSuspendedTopology(original.Shape,original.Names,JsonSerialize(corrupted),current,6);});
    for(const auto* field:{"priorNamingProof","priorNamingProofSha256","namingUpgradeBasis"}){
      auto incomplete=record;incomplete.ChangeObject().erase(field);
      rejects([&]{InspectSuspendedTopology(JsonSerialize(incomplete));});
    }
    auto selected=source;selected.StringParameters["edgeId"]="edge-3-1";selected.StringParameters["selection.edgeId"]="persistent selection";auto resolved=selected;resolved.StringParameters["edgeId"]="edge-0-8";
    require(SuspendedDefinitionFingerprint(selected)!=SuspendedDefinitionFingerprint(resolved),"Legacy definition digest must remain backward compatible");
    require(StableSuspendedDefinitionFingerprint(selected)==StableSuspendedDefinitionFingerprint(resolved),"Temporary resolved IDs must not invalidate stable archived definitions");
    resolved.StringParameters["selection.edgeId"]="different selection";require(StableSuspendedDefinitionFingerprint(selected)!=StableSuspendedDefinitionFingerprint(resolved),"A real persistent selection edit must invalidate archived definitions");
    std::cout<<"PASS exact archive re-certification retains original evidence, rejects changes and versions stable definitions\n";
  }
  storedRecoveryBoundary(false);storedRecoveryBoundary(true);
  std::cout<<"PASS malformed stored proof is atomic; old unproven suppressed files remain conservative\n";
  return 0;
}catch(const std::exception& error){std::cerr<<error.what()<<'\n';return 1;}}
