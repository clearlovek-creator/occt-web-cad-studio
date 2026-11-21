#include "../src/features/PrimitiveBuilder.hxx"
#include "../src/presentation/ShapeSerializer.hxx"
#include <BRepOffsetAPI_MakeThickSolid.hxx>
#include <BRepGProp.hxx>
#include <GProp_GProps.hxx>
#include <BRepTools_History.hxx>
#include <TopoDS.hxx>
#include <Precision.hxx>
#include <BRepFilletAPI_MakeFillet.hxx>
#include <BRepBuilderAPI_Transform.hxx>
#include <BRep_Builder.hxx>
#include <TopoDS_Compound.hxx>
#include <gp_Trsf.hxx>
#include "../src/document/CadError.hxx"
#include "../src/document/TopologyHistory.hxx"
#include "../src/document/ShapeFingerprint.hxx"
#include <iostream>
#include <stdexcept>
#include <cmath>
using namespace occweb;
void require(bool condition,const std::string& text){if(!condition)throw std::runtime_error(text);}
int main(){try{
  require(StableDigest("abc")=="ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad","Semantic digest must use standard SHA256, not platform-dependent hashes");
  FeatureNode f;f.Id="base";f.Type="primitive.box";f.NumberParameters={{"width",30},{"depth",40},{"height",20}};
  const auto base=BuildNamedPrimitive(f);ShapeSerializer input(base.Shape,0,"");int top=0;
  for(int i=1;i<=input.Faces().Extent();++i){GProp_GProps p;BRepGProp::SurfaceProperties(input.Faces()(i),p);if(std::abs(p.CentreOfMass().Z()-20)<1e-8)top=i;}
  require(top>0,"Fixture top face missing");bool complete=true;
  for(const int mode:{0,1,2}){const bool shell=mode!=2;
    BRepOffsetAPI_MakeThickSolid builder;const auto face=TopoDS::Face(input.Faces()(top));
    if(shell){NCollection_List<TopoDS_Shape> closing;closing.Append(face);builder.MakeThickSolidByJoin(base.Shape,closing,mode==0?-2:2,Precision::Confusion(),BRepOffset_Skin,false,false,GeomAbs_Arc,true);}
    else builder.MakeThickSolidBySimple(face,2);
    require(builder.IsDone(),"Offset fixture failed");const auto shape=builder.Shape();
    const TopoDS_Shape source=shell?base.Shape:face;const auto names=shell?base.Names:TopologyNaming::Restrict(base.Shape,base.Names,face);
    const auto result=TopologyNaming::FeatureResult(source,names,shape,builder,"offset",shell?std::vector<TopoDS_Shape>{face}:std::vector<TopoDS_Shape>{});ShapeSerializer sourceTopology(source,0,""),output(shape,0,"");
    for(int i=1;i<=output.Faces().Extent();++i)if(!result.count("face:"+std::to_string(i))||result.at("face:"+std::to_string(i)).empty()){
      complete=false;GProp_GProps p;BRepGProp::SurfaceProperties(output.Faces()(i),p);std::cout<<(shell?"shell":"thicken")<<" unnamed face "<<i<<" center "<<p.CentreOfMass().X()<<','<<p.CentreOfMass().Y()<<','<<p.CentreOfMass().Z()<<'\n';
    }
    if(!complete){
      std::cout<<TopologyNaming::ToJson(result)<<'\n';
      for(int i=1;i<=sourceTopology.Faces().Extent();++i){std::cout<<"source face "<<i<<" generated:";for(const auto& s:builder.Generated(sourceTopology.Faces()(i)))std::cout<<' '<<s.ShapeType()<<'/'<<output.Faces().FindIndex(s);std::cout<<" modified:";for(const auto& s:builder.Modified(sourceTopology.Faces()(i)))std::cout<<' '<<s.ShapeType()<<'/'<<output.Faces().FindIndex(s);std::cout<<'\n';}
      for(int i=1;i<=sourceTopology.Edges().Extent();++i){std::cout<<"source edge "<<i<<" generated:";for(const auto& s:builder.Generated(sourceTopology.Edges()(i)))std::cout<<' '<<s.ShapeType()<<'/'<<output.Faces().FindIndex(s);std::cout<<'\n';}
    }
  }
  require(complete,"Every generated offset face must have proven semantic evidence");
  // A retained skin is not the newly generated offset skin, even if both have
  // the same parent. Check the exact history consumed by property inheritance.
  BRepOffsetAPI_MakeThickSolid shell;NCollection_List<TopoDS_Shape> closing;closing.Append(input.Faces()(top));shell.MakeThickSolidByJoin(base.Shape,closing,-2,Precision::Confusion(),BRepOffset_Skin,false,false,GeomAbs_Arc,true);
  ShapeSerializer shelled(shell.Shape(),2,"");const auto map=TopologyHistory::Build(input,shelled,1,2,shell);
  for(int i=1;i<=input.Faces().Extent();++i)if(shelled.Faces().Contains(input.Faces()(i))){const auto& destinations=map.at("face-1-"+std::to_string(i));require(destinations==std::vector<std::string>{"face-2-"+std::to_string(shelled.Faces().FindIndex(input.Faces()(i)))},"A retained outer skin must not inherit as an offset inner skin");}
  const auto vertical=[](const ShapeSerializer& topology,double x,double y){for(int i=1;i<=topology.Edges().Extent();++i){GProp_GProps p;BRepGProp::LinearProperties(topology.Edges()(i),p);if(std::abs(p.CentreOfMass().X()-x)<1e-8&&std::abs(p.CentreOfMass().Y()-y)<1e-8)return i;}return 0;};
  const int edge=vertical(input,0,0);require(edge>0,"Fillet fixture missing");BRepFilletAPI_MakeFillet blend(base.Shape);blend.Add(2,TopoDS::Edge(input.Edges()(edge)));blend.Build();require(blend.IsDone(),"Fillet fixture failed");
  const auto names=TopologyNaming::FeatureResult(base.Shape,base.Names,blend.Shape(),blend,"blend");ShapeSerializer blended(blend.Shape(),0,"");int selected=0;
  for(const auto& generated:blend.Generated(input.Edges()(edge)))if(blended.Faces().Contains(generated))selected=blended.Faces().FindIndex(generated);require(selected>0,"Kernel must identify the generated Fillet Face");
  const auto selector=TopologyNaming::CaptureSelection(blend.Shape(),names,"face",selected);require(JsonParser(selector).Parse().GetBooleanOr("complete",false),"Generated-face selection requires complete evidence");
  TopoDS_Compound reordered;BRep_Builder compound;compound.MakeCompound(reordered);for(int i=blended.Faces().Extent();i>=1;--i)compound.Add(reordered,blended.Faces()(i));ShapeSerializer shuffled(reordered,0,"");TopologyNames shuffledNames;
  for(const std::string kind:{"face","edge"}){const auto& a=kind=="face"?blended.Faces():blended.Edges();const auto& b=kind=="face"?shuffled.Faces():shuffled.Edges();for(int i=1;i<=b.Extent();++i){const int old=a.FindIndex(b(i));const auto found=names.find(kind+':'+std::to_string(old));if(found!=names.end())shuffledNames[kind+':'+std::to_string(i)]=found->second;}}
  const int resolved=TopologyNaming::ResolveSelection(reordered,shuffledNames,selector);require(resolved!=selected && shuffled.Faces()(resolved).IsSame(blended.Faces()(selected)),"Face enumeration must not replace generated identity");
  gp_Trsf translation;translation.SetTranslation(gp_Vec(1000,0,0));BRepBuilderAPI_Transform copy(blend.Shape(),translation,true);copy.Build();require(copy.IsDone(),"Ambiguous twin fixture failed");const auto twinNames=TopologyNaming::Propagate(blend.Shape(),names,copy.Shape(),copy);ShapeSerializer twin(copy.Shape(),0,"");TopoDS_Compound twins;compound.MakeCompound(twins);compound.Add(twins,blend.Shape());compound.Add(twins,copy.Shape());ShapeSerializer both(twins,0,"");TopologyNames bothNames;
  for(const auto* source:{&blended,&twin}){const auto& sourceNames=source==&blended?names:twinNames;for(const std::string kind:{"face","edge"}){const auto& from=kind=="face"?source->Faces():source->Edges();const auto& into=kind=="face"?both.Faces():both.Edges();for(int i=1;i<=from.Extent();++i){const auto found=sourceNames.find(kind+':'+std::to_string(i));if(found!=sourceNames.end())bothNames[kind+':'+std::to_string(into.FindIndex(from(i)))]=found->second;}}}
  bool ambiguous=false;try{TopologyNaming::ResolveSelection(twins,bothNames,selector);}catch(const CadError& e){ambiguous=e.Code()=="FEATURE_SELECTION_UNRESOLVED";}require(ambiguous,"Symmetric generated identities must stay ambiguous instead of selecting the closest Face");
  const int ambiguousEdge=vertical(both,30,40);require(ambiguousEdge>0,"Ambiguous generator fixture missing");BRepFilletAPI_MakeFillet ambiguousBlend(twins);ambiguousBlend.Add(1,TopoDS::Edge(both.Edges()(ambiguousEdge)));ambiguousBlend.Build();require(ambiguousBlend.IsDone(),"Multi-solid ambiguous generator fixture failed");
  const auto ambiguousNames=TopologyNaming::FeatureResult(twins,bothNames,ambiguousBlend.Shape(),ambiguousBlend,"ambiguous-blend");ShapeSerializer ambiguousOutput(ambiguousBlend.Shape(),0,"");bool foundAmbiguous=false;for(const auto& face:ambiguousBlend.Generated(both.Edges()(ambiguousEdge))){const int index=ambiguousOutput.Faces().FindIndex(face);if(index>0){foundAmbiguous=true;require(!ambiguousNames.count("face:"+std::to_string(index)),"A unique output Face must not hide its ambiguous source generator");}}require(foundAmbiguous,"Expected an actual generated face from the ambiguous input edge");
  auto incomplete=base.Names;incomplete.erase("edge:"+std::to_string(edge));const auto unknown=TopologyNaming::FeatureResult(base.Shape,incomplete,blend.Shape(),blend,"blend");require(!unknown.count("face:"+std::to_string(selected)),"An unnamed co-generator must stay unnamed");
  const auto unproven=TopologyNaming::CaptureSelection(blend.Shape(),unknown,"face",selected);require(!JsonParser(unproven).Parse().GetBooleanOr("complete",true),"Incomplete generation evidence must not become a proven selector");bool rejected=false;try{TopologyNaming::ResolveSelection(reordered,shuffledNames,unproven);}catch(const CadError& e){rejected=e.Code()=="FEATURE_SELECTION_UNRESOLVED";}require(rejected,"Unknown origins must not regain identity by a matching index");
  std::cout<<"PASS generated topology history\n";return 0;
}catch(const std::exception& e){std::cerr<<e.what()<<'\n';return 1;}}
