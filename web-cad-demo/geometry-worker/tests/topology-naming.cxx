#include "../src/features/PrimitiveBuilder.hxx"
#include "../src/features/BooleanBuilder.hxx"
#include "../src/presentation/ShapeSerializer.hxx"
#include <BRepGProp.hxx>
#include <GProp_GProps.hxx>
#include <TopExp_Explorer.hxx>
#include <iostream>
#include <stdexcept>
#include <BRep_Builder.hxx>
#include <BRepMesh_IncrementalMesh.hxx>
#include <BRepFilletAPI_MakeFillet.hxx>
#include <BRepCheck_Analyzer.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Compound.hxx>
#include "../src/document/ShapeFingerprint.hxx"
#include "../src/document/CadError.hxx"
#include "../src/document/CadDocument.hxx"
#include "../src/document/SuspendedTopology.hxx"
#include "../src/document/UserPropertyStore.hxx"
#include <XCAFApp_Application.hxx>
#include <TDocStd_Application.hxx>
#include <filesystem>
#include <fstream>
#include <chrono>

using namespace occweb;
void require(bool condition,const std::string& message){if(!condition)throw std::runtime_error(message);}
FeatureNode box(const std::string& id,double width=100){FeatureNode feature;feature.Id=id;feature.Type="primitive.box";feature.NumberParameters={{"width",width},{"depth",100},{"height",20}};return feature;}
double centerX(const TopoDS_Shape& shape){GProp_GProps props;BRepGProp::VolumeProperties(shape,props);return props.CentreOfMass().X();}
std::vector<NamedTopologyBody> pieces(const FeatureNode& base,const FeatureNode& tool,int revision)
{
  const auto a=BuildNamedPrimitive(base),b=BuildNamedPrimitive(tool);
  const auto cut=BuildBooleanOperation("boolean.cut",{a.Shape},{b.Shape},true);
  std::vector<NamedTopologyBody> bodies;
  for(TopExp_Explorer solid(cut.Shape,TopAbs_SOLID);solid.More();solid.Next()){
    auto names=TopologyNaming::Propagate(a.Shape,a.Names,solid.Current(),*cut.History);
    TopologyNaming::Merge(names,TopologyNaming::Propagate(b.Shape,b.Names,solid.Current(),*cut.History));TopologyNaming::CompleteEdges(solid.Current(),names);
    bodies.push_back({solid.Current(),std::move(names),revision,"cut"});
  }
  require(bodies.size()==2,"Fixture must produce two solids");
  if(centerX(bodies[0].Shape)>centerX(bodies[1].Shape))std::swap(bodies[0],bodies[1]);return bodies;
}
std::string topId(const NamedTopologyBody& body)
{
  for(const auto& [key,origins]:body.Names)if(key.rfind("face:",0)==0)for(const auto& root:origins)if(root=="base/primitive.box/top")return "face-"+std::to_string(body.Revision)+'-'+key.substr(5);
  throw std::runtime_error("The top face must have its constructor identity");
}
int main()
{
  try {
    {
      // Two real solids share the same immediate constructor roots. A distinct
      // remote bottom generator is reachable only through their side Faces.
      const auto branch=[](const std::string& remote,double x,int revision,double width){
        auto definition=box("shared",width);definition.NumberParameters["x"]=x;
        auto built=BuildNamedPrimitive(definition);
        for(auto& [id,origin]:built.Names)if(id.rfind("face:",0)==0)
          for(auto& root:origin)if(root=="shared/primitive.box/bottom")root="remote/"+remote;
        for(auto it=built.Names.begin();it!=built.Names.end();)if(it->first.rfind("edge:",0)==0)it=built.Names.erase(it);else ++it;
        TopologyNaming::CompleteEdges(built.Shape,built.Names);
        return NamedTopologyBody{built.Shape,built.Names,revision,"same-boolean-result"};
      };
      const auto a=branch("A",0,7,100),b=branch("B",300,7,100);
      const auto nextA=branch("A",1000,9,120),nextB=branch("B",-500,9,80);
      const auto originalNames=TopologyNaming::ToJson(a.Names),originalShape=ShapeFingerprint(a.Shape);
      const auto selected=[](const NamedTopologyBody& body,const std::string& kind){
        for(const auto& [id,origins]:body.Names)if(id.rfind(kind+':',0)==0)
          for(const auto& origin:origins)if(origin.find("shared/primitive.box/top")!=std::string::npos)
            return kind+'-'+std::to_string(body.Revision)+'-'+id.substr(kind.size()+1);
        throw std::runtime_error("Missing common top selection");
      };
      const auto mapped=TopologyNaming::MatchBodies({{"old-a",a},{"old-b",b}},{{"slot-a",nextB},{"slot-b",nextA}});
      for(const std::string kind:{"face","edge"}){
        const auto source=selected(a,kind);
        const auto right=mapped.at("old-a").find("slot-b");
        require(right!=mapped.at("old-a").end()&&right->second.find(source)!=right->second.end()&&right->second.at(source).size()==1,"Remote unique topology must distinguish repeated "+kind+" origins");
        const auto wrong=mapped.at("old-a").find("slot-a");
        require(wrong==mapped.at("old-a").end() || wrong->second.find(source)==wrong->second.end() || wrong->second.at(source).empty(),"No proximity, enumeration or wrong remote branch fallback is allowed");
      }
      const auto twinA=branch("same",0,7,100),twinB=branch("same",300,7,100);
      const auto ambiguous=TopologyNaming::MatchBodies({{"a",twinA},{"b",twinB}},{{"a",branch("same",1000,9,120)},{"b",branch("same",-500,9,80)}});
      for(const auto& [unused,bodies]:ambiguous)for(const auto& [id,entries]:bodies)for(const auto& [source,targets]:entries)require(targets.empty(),"Structurally identical branches must remain unresolved despite different coordinates and dimensions");
      std::cout<<"PASS bounded remote topology context distinguishes real repeated Face/Edge branches without geometric guessing\n";
      const auto unresolved=[&](const BodyTopologyRemaps& mappings,const std::string& body,const std::string& kind){const auto source=selected(a,kind);for(const auto& [unused,entries]:mappings.at(body)){const auto entry=entries.find(source);if(entry!=entries.end()&&!entry->second.empty())return false;}return true;};
      for(const std::size_t budget:{1u,100u,12000u}){
        const auto limited=TopologyNaming::MatchBodies({{"old-a",a},{"old-b",b}},{{"slot-a",nextB},{"slot-b",nextA}},budget);
        require(unresolved(limited,"old-a","face")&&unresolved(limited,"old-a","edge"),"Partial context work must never make a repeated branch falsely unique");
      }
      auto incomplete=a;
      for(auto it=incomplete.Names.begin();it!=incomplete.Names.end();)if(std::find(it->second.begin(),it->second.end(),"remote/A")!=it->second.end())it=incomplete.Names.erase(it);else ++it;
      const auto missing=TopologyNaming::MatchBodies({{"old-a",incomplete},{"old-b",b}},{{"slot-a",nextB},{"slot-b",nextA}});
      require(unresolved(missing,"old-a","face")&&unresolved(missing,"old-a","edge"),"Missing remote generator evidence must not prove an association");
      const auto duplicated=TopologyNaming::MatchBodies({{"old-a",a},{"old-b",b}},{{"slot-a",nextB},{"slot-b",nextA},{"slot-c",branch("A",5000,9,50)}});
      require(unresolved(duplicated,"old-a","face")&&unresolved(duplicated,"old-a","edge"),"Two indistinguishable current branches must not be chosen by ordering or size");
      for(const std::size_t invalid:{0u,1000001u}){bool rejected=false;try{TopologyNaming::MatchBodies({{"a",a}},{{"b",nextA}},invalid);}catch(const CadError&){rejected=true;}require(rejected,"Invalid optional context limits must be rejected");}
      require(TopologyNaming::ToJson(a.Names)==originalNames&&ShapeFingerprint(a.Shape)==originalShape,"Read-only context matching cannot change persistent roots or BRep geometry");
      std::cout<<"PASS remote context budgets, incomplete proof and duplicate destinations remain unresolved and read-only\n";
      const auto compound=[](const NamedTopologyBody& first,const NamedTopologyBody& second){
        TopoDS_Compound shape;BRep_Builder builder;builder.MakeCompound(shape);builder.Add(shape,first.Shape);builder.Add(shape,second.Shape);
        NamedTopologyBody result{shape,{},first.Revision,"compound"};ShapeSerializer topology(shape,0,"");
        for(const auto* body:{&first,&second}){ShapeSerializer source(body->Shape,0,"");for(const std::string kind:{"face","edge"}){const auto& original=kind=="face"?source.Faces():source.Edges();const auto& current=kind=="face"?topology.Faces():topology.Edges();for(int i=1;i<=original.Extent();++i){const auto found=body->Names.find(kind+':'+std::to_string(i));if(found!=body->Names.end())result.Names[kind+':'+std::to_string(current.FindIndex(original(i)))]=found->second;}}}
        return result;
      };
      const auto input=compound(a,b),changed=compound(nextB,nextA);
      ShapeSerializer inputTopology(input.Shape,0,""),changedTopology(changed.Shape,0,"");
      for(const std::string kind:{"face","edge"}){
        const auto& sourceMap=kind=="face"?inputTopology.Faces():inputTopology.Edges();
        ShapeSerializer local(a.Shape,0,"");const auto& localMap=kind=="face"?local.Faces():local.Edges();
        const auto localId=selected(a,kind);const int localIndex=std::stoi(localId.substr(localId.rfind('-')+1));
        const int index=sourceMap.FindIndex(localMap(localIndex));
        const auto selector=TopologyNaming::CaptureSelection(input.Shape,input.Names,kind,index);
        const auto stored=JsonParser(selector).Parse();
        require(stored.GetInteger("neighborhoodCount")==2,"Selection fixture must really have repeated one-ring references within one Body");
        require(stored.Has("remoteContext")&&stored.At("remoteContext").GetInteger("matchCount")==1,"A new ambiguous-near selection needs a unique captured remote proof");
        require(TopologyNaming::SelectionProof(input.Shape,input.Names,kind,index).empty(),"Remote selection evidence must not silently rewrite generated topology naming proofs");
        const int resolved=TopologyNaming::ResolveSelection(changed.Shape,changed.Names,selector);
        ShapeSerializer expected(nextA.Shape,0,"");const auto& currentMap=kind=="face"?changedTopology.Faces():changedTopology.Edges();const auto& expectedMap=kind=="face"?expected.Faces():expected.Edges();
        require(currentMap(resolved).IsSame(expectedMap(localIndex)),"Persistent selection must follow the actual remote branch after reordering");
        const auto capturedSet=JsonParser(JsonSerialize(TopologyNaming::CaptureSelectionSet(input.Shape,input.Names))).Parse();
        const auto restoredSet=TopologyNaming::ResolveSelectionSet(changed.Shape,changed.Names,capturedSet,7,9);
        const auto sourceId=kind+"-7-"+std::to_string(index);
        require(restoredSet.at(sourceId)==std::vector<std::string>{kind+"-9-"+std::to_string(currentMap.FindIndex(expectedMap(localIndex)))},"Suppressed "+kind+" selection must follow its unique remote branch after persistence and reordered geometry");
        require(JsonSerialize(capturedSet.At("entries").At(kind+':'+std::to_string(index)).At("remoteContext"))==JsonSerialize(stored.At("remoteContext")),"Bulk remote evidence must agree with the individual persistent selection");
        const auto bulk=[&](const TopoDS_Shape& shape,const TopologyNames& names,const JsonValue& set,std::size_t budget=1000000){return TopologyNaming::ResolveSelectionSet(shape,names,set,7,9,true,budget).at(sourceId);};
        auto legacySet=capturedSet;
        for(auto& [unused,entry]:legacySet.ChangeObject().at("entries").ChangeObject())entry.ChangeObject().erase("remoteContext");
        require(bulk(changed.Shape,changed.Names,legacySet).empty(),"Old bulk archives cannot acquire missing remote evidence retroactively");
        require(bulk(input.Shape,input.Names,legacySet)==std::vector<std::string>{kind+"-9-"+std::to_string(index)},"Old bulk exact unchanged geometry must remain recoverable");
        const auto limitedSet=TopologyNaming::CaptureSelectionSet(input.Shape,input.Names,1);
        for(const auto& [unused,entry]:limitedSet.At("entries").AsObject())require(!entry.Has("remoteContext"),"One exhausted shared budget must not retain a partial Face/Edge proof index");
        require(bulk(changed.Shape,changed.Names,limitedSet).empty()&&bulk(changed.Shape,changed.Names,capturedSet,1).empty(),"Bulk capture/resolution budget exhaustion must leave repeated origins unresolved");
        require(bulk(nextA.Shape,nextA.Names,capturedSet)==std::vector<std::string>{kind+"-9-"+std::to_string(localIndex)},"The uniquely proven archived branch may survive removal of another branch");
        require(bulk(nextB.Shape,nextB.Names,capturedSet).empty(),"The single wrong remaining branch must not inherit archived properties");
        FeatureNode archive=box("remote-source");archive.Identity="remote-source-uuid";
        SuspendedTopologyIdentity identity{"remote-body","remote-body-uuid","remote-topology-uuid",archive.Id,archive.Identity,7,SuspendedDefinitionFingerprint(archive)};
        const auto archived=CaptureSuspendedTopology(input.Shape,input.Names,identity);
        archive.SuspendedTopology[identity.BodyId]=archived;
        const auto persisted=FeatureNode::FromJson(JsonParser(archive.ToJson(true)).Parse());
        const auto recovered=ResolveSuspendedTopology(changed.Shape,changed.Names,persisted.SuspendedTopology.at(identity.BodyId),identity,9);
        require(recovered.Verified&&recovered.Mapping.at(sourceId)==restoredSet.at(sourceId),"Remote evidence must survive private feature persistence and ownership verification");
        UserPropertyStore beforeProperties;beforeProperties.Set(kind,identity.BodyId,sourceId,"boundaryTag","int",JsonValue(50.0));beforeProperties.OrphanBody(identity.BodyId,"suppressed");
        const auto orphaned=JsonParser(beforeProperties.ToJson()).Parse();UserPropertyStore properties;properties.FromJson(orphaned);
        properties.RemapTopology(identity.BodyId,identity.BodyId,recovered.Mapping,"verified recovery",true);
        int activeProperties=0;
        const auto recoveredProperties=JsonParser(properties.ToJson()).Parse();
        for(const auto& property:recoveredProperties.AsArray())if(property.GetString("state")=="active"){
          ++activeProperties;require(property.GetString("topologyId")==restoredSet.at(sourceId).front()&&property.At("values").At("boundaryTag").GetInteger("value")==50,"Only the physical proven branch must recover its stored property value");
        }
        require(activeProperties==1,"Recovery must reactivate exactly one proven physical property");
        UserPropertyStore wrongProperties;wrongProperties.FromJson(orphaned);wrongProperties.RemapTopology(identity.BodyId,identity.BodyId,TopologyNaming::ResolveSelectionSet(nextB.Shape,nextB.Names,capturedSet,7,9),"unproven recovery",true);
        require(JsonParser(wrongProperties.ToJson()).Parse().AsArray().front().GetString("state")=="orphaned","A wrong remaining branch must leave the stored property orphaned");
        auto oldArchive=JsonParser(archived).Parse();oldArchive.ChangeObject()["selectionSet"]=legacySet;
        const auto migrated=JsonParser(RecertifySuspendedTopology(JsonSerialize(oldArchive),input.Shape,input.Names,input.Shape,input.Names,archive,archive,identity.BodyId,identity.BodyIdentity,8)).Parse();
        require(JsonSerialize(migrated.At("priorNamingProof"))==JsonSerialize(oldArchive),"Exact re-certification must retain old archives without rewriting their missing optional evidence");
        require(TopologyNaming::ResolveSelection(changed.Shape,changed.Names,JsonSerialize(stored))==resolved,"Versioned remote selection must survive JSON persistence roundtrip");
        const auto rejected=[&](const TopoDS_Shape& shape,const TopologyNames& names,const std::string& reference,std::size_t budget=1000000){try{TopologyNaming::ResolveSelection(shape,names,reference,budget);return false;}catch(const CadError&){return true;}};
        auto legacy=stored;legacy.ChangeObject().erase("remoteContext");
        require(rejected(changed.Shape,changed.Names,JsonSerialize(legacy)),"Legacy ambiguous references cannot acquire source evidence retroactively");
        require(TopologyNaming::ResolveSelection(input.Shape,input.Names,JsonSerialize(legacy))==index,"Legacy exact unchanged geometry stays editable");
        const auto limited=TopologyNaming::CaptureSelection(input.Shape,input.Names,kind,index,1);
        require(!JsonParser(limited).Parse().Has("remoteContext")&&rejected(changed.Shape,changed.Names,limited),"Capture budget exhaustion must not persist partial proof");
        require(rejected(changed.Shape,changed.Names,selector,1),"Resolution budget exhaustion must not choose an arbitrary repeated branch");
        require(TopologyNaming::ResolveSelection(nextA.Shape,nextA.Names,selector)==localIndex,"The proven selected branch may survive after another branch is removed");
        require(rejected(nextB.Shape,nextB.Names,selector),"A single remaining wrong branch is not proof that the selected branch survived");
        const auto repeated=compound(changed,branch("A",5000,9,50));
        require(bulk(repeated.Shape,repeated.Names,capturedSet).empty(),"Duplicate current remote branches must not reactivate an archived selection");
        require(rejected(repeated.Shape,repeated.Names,selector),"Two current remote matches must require explicit reselection");
        auto missingNames=changed.Names;
        for(auto it=missingNames.begin();it!=missingNames.end();)if(std::find(it->second.begin(),it->second.end(),"remote/A")!=it->second.end())it=missingNames.erase(it);else ++it;
        require(rejected(changed.Shape,missingNames,selector),"Missing remote generator cannot be hidden by remaining named neighbors");
        require(bulk(changed.Shape,missingNames,capturedSet).empty(),"Missing remote source evidence must also block bulk recovery");
        for(int fault=0;fault<6;++fault){
          auto broken=capturedSet;auto& context=broken.ChangeObject().at("entries").ChangeObject().at(kind+':'+std::to_string(index)).ChangeObject().at("remoteContext");
          if(fault==0)context.ChangeObject()["version"]=JsonValue(2.0);if(fault==1)context.ChangeObject()["basis"]=JsonValue(std::string("unknown"));if(fault==2)context.ChangeObject()["matchCount"]=JsonValue(2.0);if(fault==3)context.ChangeObject()["hash"]=JsonValue(std::string("bad"));if(fault==4)context.ChangeObject().erase("hash");if(fault==5)context=JsonValue();
          bool refused=false;try{bulk(input.Shape,input.Names,broken);}catch(const CadError& error){refused=error.Code()=="INVALID_SUSPENDED_TOPOLOGY";}require(refused,"Malformed remote evidence must be rejected even on exact unchanged archived geometry");
        }
        auto nonmatchingSet=capturedSet;nonmatchingSet.ChangeObject().at("entries").ChangeObject().at(kind+':'+std::to_string(index)).ChangeObject().at("remoteContext").ChangeObject()["hash"]=JsonValue(std::string(64,'0'));
        require(bulk(changed.Shape,changed.Names,nonmatchingSet).empty(),"A syntactically valid but nonmatching remote digest cannot authorize bulk recovery");
        for(const std::size_t invalid:{0u,1000001u}){bool refusedCapture=false,refusedResolve=false;try{TopologyNaming::CaptureSelectionSet(input.Shape,input.Names,invalid);}catch(const CadError&){refusedCapture=true;}try{bulk(input.Shape,input.Names,capturedSet,invalid);}catch(const CadError&){refusedResolve=true;}require(refusedCapture&&refusedResolve,"Bulk context limits must remain enforced on exact paths too");}
        for(int fault=0;fault<7;++fault){auto broken=stored;auto& context=broken.ChangeObject().at("remoteContext");if(fault==0)context.ChangeObject()["version"]=JsonValue(2.0);if(fault==1)context.ChangeObject()["basis"]=JsonValue(std::string("unknown"));if(fault==2)context.ChangeObject()["matchCount"]=JsonValue(2.0);if(fault==3)context.ChangeObject()["hash"]=JsonValue(std::string("bad"));if(fault==4)context.ChangeObject().erase("hash");if(fault==5)context=JsonValue();if(fault==6)context.ChangeObject()["hash"]=JsonValue(std::string(64,'0'));require(rejected(changed.Shape,changed.Names,JsonSerialize(broken)),"Invalid or nonmatching remote proof must not be accepted");}
        for(const std::size_t invalid:{0u,1000001u}){bool captureRejected=false;try{TopologyNaming::CaptureSelection(input.Shape,input.Names,kind,index,invalid);}catch(const CadError&){captureRejected=true;}require(captureRejected&&rejected(changed.Shape,changed.Names,selector,invalid),"Persistent reference context limits cannot be disabled or expanded");}
        if(kind=="edge"){BRepFilletAPI_MakeFillet fillet(changed.Shape);fillet.Add(2,TopoDS::Edge(currentMap(resolved)));fillet.Build();require(fillet.IsDone()&&!fillet.Shape().IsNull()&&BRepCheck_Analyzer(fillet.Shape()).IsValid(),"The resolved actual Edge must support a valid downstream fillet");}
      }
      std::cout<<"PASS persistent remote Face/Edge selections follow reordered real solids and drive an actual fillet\n";
      std::cout<<"PASS remote selectors retain legacy exact behavior, reject missing and corrupt proof, enforce budgets and survive persistence\n";
      std::cout<<"PASS bulk archived Face/Edge recovery shares bounded remote evidence, restores proven properties and retains old archive compatibility\n";
    }
    {
      const auto shape=BuildNamedPrimitive(box("import-fixture")).Shape;
      const std::string source(64,'a');
      const auto names=TopologyNaming::ImportedSource(shape,"import-feature","body-1",source);
      require(names==TopologyNaming::ImportedSource(shape,"import-feature","body-1",source),"Immutable imported source names must be repeatable");
      const std::map<std::string,NamedTopologyBody> before{{"body-1",{shape,names,1,"import-feature"}}};
      const auto changedOccurrence=TopologyNaming::ImportedSource(shape,"import-feature","body-2",source);
      const auto changedSource=TopologyNaming::ImportedSource(shape,"import-feature","body-1",std::string(64,'b'));
      const auto first=TopologyNaming::MatchBodies(before,{{"body-2",{shape,changedOccurrence,2,"import-feature"}}});
      const auto second=TopologyNaming::MatchBodies(before,{{"body-1",{shape,changedSource,2,"import-feature"}}});
      const auto unresolved=[](const BodyTopologyRemaps& mappings){for(const auto& [source,bodies]:mappings)for(const auto& [body,topology]:bodies)for(const auto& [id,targets]:topology)if(!targets.empty())return false;return true;};
      require(unresolved(first)&&unresolved(second),"Coincident imported occurrences and different source bytes must never share topology roots");
      const auto otherPart=BuildNamedPrimitive(box("another-part",31)).Shape;
      const auto otherNames=TopologyNaming::ImportedSource(otherPart,"import-feature","body-1",source);
      require(unresolved(TopologyNaming::MatchBodies(before,{{"body-1",{otherPart,otherNames,2,"import-feature"}}})),"Changed whole parts cannot borrow even their geometrically unchanged Face subset");
      bool rejected=false;try{TopologyNaming::ImportedSource(shape,"import-feature","body-1","unverified");}catch(const CadError&){rejected=true;}
      require(rejected,"Unverified source must not receive persistent imported names");
      std::cout<<"PASS immutable STEP topology names bind exact source, whole part and distinct occurrence\n";
    }
    auto base=box("base");auto tool=box("tool",20);tool.NumberParameters["depth"]=120;tool.NumberParameters["height"]=40;tool.NumberParameters["x"]=40;tool.NumberParameters["y"]=-10;tool.NumberParameters["z"]=-10;
    const auto old=pieces(base,tool,7);base.NumberParameters["width"]=120;tool.NumberParameters["x"]=50;const auto next=pieces(base,tool,9);
    const auto mapped=TopologyNaming::MatchBodies({{"left",old[0]},{"right",old[1]}},{{"left",next[1]},{"right",next[0]}});
    const auto source=topId(old[0]);require(mapped.at("left").at("right").at(source).size()==1,"Swapped results must carry the left face to the other Body ID");
    require(mapped.at("left").at("left").at(source).empty(),"Result index must never override semantic branch identity");
    std::cout<<"PASS cross-Body identity survives swapped result order\n";
    auto primitive=BuildNamedPrimitive(box("base"));NamedTopologyBody twin{primitive.Shape,primitive.Names,1,"same-creator"};auto later=twin;later.Revision=2;
    const auto ambiguous=TopologyNaming::MatchBodies({{"a",twin},{"b",twin}},{{"a",later},{"b",later}});
    for(const auto& [unused,destinations]:ambiguous)for(const auto& [body,mapping]:destinations)for(const auto& [id,targets]:mapping)require(targets.empty(),"Indistinguishable twins must remain unresolved");
    std::cout<<"PASS symmetric duplicate origins stay unresolved\n";
    auto movedFeature=box("base",120);movedFeature.NumberParameters["height"]=50;movedFeature.NumberParameters["csOriginX"]=1000;movedFeature.NumberParameters["csOriginZ"]=300;
    auto moved=BuildNamedPrimitive(movedFeature);NamedTopologyBody after{moved.Shape,moved.Names,4,"same-creator"};
    const auto shifted=TopologyNaming::MatchBodies({{"a",twin}},{{"a",after}});require(shifted.at("a").at("a").at(topId(twin)).size()==1,"Constructor roles must survive large coordinate changes");
    std::cout<<"PASS role identity survives large dimension and coordinate changes\n";
    const auto reference=BuildNamedPrimitive(box("selection"));
    ShapeSerializer originalTopology(reference.Shape,0,"");
    const auto selector=TopologyNaming::CaptureSelection(reference.Shape,reference.Names,"edge",1);
    TopoDS_Compound reordered;BRep_Builder builder;builder.MakeCompound(reordered);
    for(int i=originalTopology.Faces().Extent();i>=1;--i)builder.Add(reordered,originalTopology.Faces()(i));
    ShapeSerializer reorderedTopology(reordered,0,"");TopologyNames reorderedNames;
    for(const std::string kind:{"face","edge"}){
      const auto& original=kind=="face"?originalTopology.Faces():originalTopology.Edges();
      const auto& current=kind=="face"?reorderedTopology.Faces():reorderedTopology.Edges();
      for(int i=1;i<=current.Extent();++i){const int oldIndex=original.FindIndex(current(i));if(oldIndex)reorderedNames[kind+':'+std::to_string(i)]=reference.Names.at(kind+':'+std::to_string(oldIndex));}
    }
    const int resolved=TopologyNaming::ResolveSelection(reordered,reorderedNames,selector);
    require(resolved!=1,"Fixture must really change the selected edge's enumeration index");
    require(reorderedTopology.Edges()(resolved).IsSame(originalTopology.Edges()(1)),"Persistent selector must return the actual old edge, not its previous index");
    std::cout<<"PASS persistent selection survives changed edge enumeration\n";
    const auto exact=TopologyNaming::CaptureSelection(reference.Shape,{},"edge",1);
    require(TopologyNaming::ResolveSelection(reference.Shape,{},exact)==1,"Unnamed topology must remain editable when exact BRep is unchanged");
    BRepMesh_IncrementalMesh mesher(reference.Shape,.1,false,.25,true);
    require(ShapeFingerprint(reference.Shape)==JsonParser(exact).Parse().GetString("fingerprint"),"Display tessellation must not alter the precise BRep fingerprint");
    bool rejected=false;try{TopologyNaming::ResolveSelection(moved.Shape,{},exact);}catch(const CadError&){rejected=true;}
    require(rejected,"Changed unnamed geometry must not fall back to its old edge index");
    std::cout<<"PASS exact BRep selection excludes tessellation and rejects unproven changes\n";
    auto partial=reference.Names;partial.erase("face:1");
    const auto incomplete=TopologyNaming::CaptureSelection(reference.Shape,partial,"edge",1);
    require(!JsonParser(incomplete).Parse().GetBooleanOr("complete",true),"Fixture must have an unnamed face in the selected edge neighborhood");
    rejected=false;try{TopologyNaming::ResolveSelection(reordered,reorderedNames,incomplete);}catch(const CadError&){rejected=true;}
    require(rejected,"Incomplete old neighborhood cannot become falsely unique after a geometry change");
    std::cout<<"PASS incomplete persistent selections remain unresolved\n";
    const auto temporary = std::filesystem::temp_directory_path() / ("cad-step-replay-" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()) + ".step");
    struct RemoveFixture { std::filesystem::path Path; ~RemoveFixture(){std::error_code error;std::filesystem::remove(Path,error);} } removeFixture{temporary};
    CadDocument stepSource("step-source");stepSource.CreateBox("box",30,30,30,false);stepSource.ExportStep("export",temporary.u8string());
    CadDocument imported("step-replay");imported.ImportStep("import",temporary.u8string());
    const auto importedView=JsonParser(imported.View("view")).Parse();
    const auto importedBody=importedView.GetString("bodyId"),firstFace=importedView.At("triangleFaceIds").AsArray().front().AsString();
    imported.OffsetFeature("shell",imported.Revision(),"detail.shell",importedBody,firstFace,JsonParser("{\"thickness\":2,\"inward\":true}").Parse());
    const auto app=XCAFApp_Application::GetApplication();const int documentCount=app->NbDocuments();
    for(int pass=0;pass<5;++pass)imported.PreviewFeatureInput("inspect",imported.Revision(),"feature-2","feature-2",JsonValue::MakeObject());
    require(app->NbDocuments()==documentCount,"Repeated imported input previews must close their temporary XCAF documents");
    {std::ofstream corrupt(temporary);corrupt<<"invalid STEP source";}
    rejected=false;try{imported.PreviewFeatureInput("bad-source",imported.Revision(),"feature-2","feature-2",JsonValue::MakeObject());}catch(const CadError&){rejected=true;}
    require(rejected,"The corrupted retained STEP source must fail replay");
    require(app->NbDocuments()==documentCount,"Failed STEP input previews must close temporary XCAF documents too");
    std::cout<<"PASS imported input previews release temporary documents on success and failure\n";
    return 0;
  } catch(const std::exception& error){std::cerr<<error.what()<<'\n';return 1;}
}
