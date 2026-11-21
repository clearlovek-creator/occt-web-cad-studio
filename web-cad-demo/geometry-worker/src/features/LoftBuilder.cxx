#include "LoftBuilder.hxx"
#include "../document/CadError.hxx"
#include "../document/ShapeFingerprint.hxx"
#include "../document/SolidOrientation.hxx"
#include "../presentation/ShapeSerializer.hxx"
#include <BRepOffsetAPI_ThruSections.hxx>
#include <BRepBuilderAPI_MakePolygon.hxx>
#include <BRepBuilderAPI_Transform.hxx>
#include <BRepAdaptor_Surface.hxx>
#include <BRepTools.hxx>
#include <BRepCheck_Analyzer.hxx>
#include <BRepCheck_Wire.hxx>
#include <BRepGProp.hxx>
#include <BRepBndLib.hxx>
#include <BRep_Builder.hxx>
#include <Bnd_Box.hxx>
#include <GProp_GProps.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Compound.hxx>
#include <TopoDS_Wire.hxx>
#include <gp_Vec.hxx>
#include <TopExp_Explorer.hxx>
#include <gp_Trsf.hxx>
#include <cmath>
#include <algorithm>

namespace occweb
{
bool IsProfileLoft(const FeatureNode& feature)
{
  const auto found=feature.StringParameters.find("loftVersion");
  if(found==feature.StringParameters.end())return false;
  if(found->second!="2" && found->second!="3")throw CadError("UNSUPPORTED_LOFT_VERSION","Unsupported Loft definition version.");
  return true;
}
LoftProfile ResolveLoftProfile(const TopoDS_Shape& shape,const TopologyNames& names,const JsonValue& reference)
{
  const auto selector=JsonParser(reference.GetString("selector")).Parse();
  if(selector.GetStringOr("kind","")!="face" || selector.GetIntegerOr("version",0)!=1 || reference.GetString("bodyIdentity").empty() || reference.GetString("featureIdentity").empty())
    throw CadError("INVALID_LOFT_REFERENCE","A Loft profile requires a versioned Face selector and persistent source identities; Edge indexes cannot substitute Faces.");
  int index=0;
  try{index=TopologyNaming::ResolveSelection(shape,names,reference.GetString("selector"));}
  catch(const CadError& error){throw CadError("LOFT_SECTION_UNRESOLVED","Loft section "+reference.GetString("sectionId")+" cannot be resolved: "+error.what());}
  ShapeSerializer topology(shape,0,"");const auto face=TopoDS::Face(topology.Faces()(index));
  auto proof=TopologyNaming::SelectionProof(shape,names,"face",index);
  if(!proof.empty())proof=StableDigest(reference.GetString("sectionId")+"/"+reference.GetString("bodyIdentity")+"/"+reference.GetString("featureIdentity")+"/"+proof);
  LoftProfile result{face,TopologyNaming::Restrict(shape,names,face),proof};
  if(reference.Has("holeSelectors")){
    const auto& holes=reference.At("holeSelectors");
    if(!holes.IsArray() || holes.AsArray().empty() || holes.AsArray().size()>16)throw CadError("INVALID_LOFT_HOLE_MAPPING","Stored Loft hole correspondence is invalid.");
    for(const auto& stored:holes.AsArray()){
      if(!stored.IsString())throw CadError("INVALID_LOFT_HOLE_MAPPING","Stored hole selector must be a versioned edge reference.");
      const auto token=JsonParser(stored.AsString()).Parse();
      if(token.GetStringOr("kind","")!="edge" || token.GetIntegerOr("version",0)!=1)throw CadError("INVALID_LOFT_HOLE_MAPPING","Hole correspondence requires an Edge selector, not a Face index.");
      int edgeIndex=0;
      try{edgeIndex=TopologyNaming::ResolveSelection(shape,names,stored.AsString());}catch(const CadError& error){throw CadError("LOFT_SECTION_UNRESOLVED","An inner-loop seed cannot be resolved: "+std::string(error.what()));}
      const auto& seed=topology.Edges()(edgeIndex);TopoDS_Wire loop;int found=0;
      for(TopExp_Explorer wire(face,TopAbs_WIRE);wire.More();wire.Next()){
        if(wire.Current().IsSame(BRepTools::OuterWire(face)))continue;
        bool contains=false;for(TopExp_Explorer edge(wire.Current(),TopAbs_EDGE);edge.More();edge.Next())if(edge.Current().IsSame(seed))contains=true;
        if(contains){loop=TopoDS::Wire(wire.Current());++found;}
      }
      if(found!=1)throw CadError("INVALID_LOFT_HOLE_MAPPING","The selected seed must belong to exactly one inner boundary of the selected Face.");
      for(const auto& existing:result.Holes)if(existing.IsSame(loop))throw CadError("INVALID_LOFT_HOLE_MAPPING","Two seed edges refer to the same hole; map every inner loop exactly once.");
      // The seed identifies the wire, but is not the wire's semantic identity.
      // Require complete evidence for its whole boundary and canonicalize it,
      // so choosing another edge of the same polygon cannot rename the loop.
      std::vector<std::string> boundaryProofs;bool complete=true;
      for(TopExp_Explorer edge(loop,TopAbs_EDGE);edge.More();edge.Next()){
        const auto boundary=TopologyNaming::SelectionProof(shape,names,"edge",topology.Edges().FindIndex(edge.Current()));
        complete=complete&&!boundary.empty();boundaryProofs.push_back(boundary);
      }
      std::sort(boundaryProofs.begin(),boundaryProofs.end());std::string basis;
      for(const auto& boundary:boundaryProofs)basis+=std::to_string(boundary.size())+':'+boundary;
      const auto holeProof=complete?StableDigest(reference.GetString("sectionId")+"/"+reference.GetString("bodyIdentity")+"/"+reference.GetString("featureIdentity")+"/hole/"+basis):std::string();
      result.Holes.push_back(loop);result.HoleProofs.push_back(holeProof);
    }
  }
  return result;
}
namespace
{
void valid(const TopoDS_Shape& shape){if(shape.IsNull() || !BRepCheck_Analyzer(shape).IsValid())throw CadError("INVALID_RESULT","Loft did not produce valid geometry.");}
double number(const FeatureNode& feature,const std::string& key,double fallback){const auto it=feature.NumberParameters.find(key);return it==feature.NumberParameters.end()?fallback:it->second;}
TopoDS_Wire profileWire(const TopoDS_Face& face)
{
  if(face.IsNull() || !BRepCheck_Analyzer(face).IsValid() || BRepAdaptor_Surface(face).GetType()!=GeomAbs_Plane)
    throw CadError("INVALID_LOFT_PROFILE","Loft requires a valid planar Face, not a whole Solid or a curved surface.");
  int wires=0;for(TopExp_Explorer wire(face,TopAbs_WIRE);wire.More();wire.Next())++wires;
  if(wires!=1)throw CadError("LOFT_PROFILE_HOLES_UNSUPPORTED","A Loft section must have one closed boundary. Faces with holes require an explicit multi-loop correspondence and are not approximated.");
  const auto wire=BRepTools::OuterWire(face);
  if(wire.IsNull() || BRepCheck_Wire(wire).Closed()!=BRepCheck_NoError)throw CadError("INVALID_LOFT_PROFILE","Loft profile boundary is not closed.");
  return wire;
}
}
LoftBuildResult BuildLoft(const std::vector<LoftProfile>& profiles,const FeatureNode& feature)
{
  if(profiles.size()<2 || profiles.size()>32)throw CadError("INVALID_LOFT_SECTIONS","Loft requires 2 to 32 ordered Face sections.");
  const auto placement=feature.StringParameters.at("loftPlacement");
  if(placement!="actual" && placement!="z-spacing")throw CadError("INVALID_PARAMETER","Unknown Loft placement mode.");
  const auto naming=feature.StringParameters.find("loftNamingVersion");
  const bool endpointCaps=naming!=feature.StringParameters.end();
  if(endpointCaps && naming->second!="2")throw CadError("UNSUPPORTED_LOFT_NAMING_VERSION","Unsupported Loft topology naming version.");
  if(feature.StringParameters.count("loftVersion") && feature.StringParameters.at("loftVersion")=="3")return BuildMultiLoopLoft(profiles,feature);
  const auto spacing=number(feature,"sectionSpacing",10);
  if(placement=="z-spacing" && (!std::isfinite(spacing) || std::abs(spacing)<1e-7 || std::abs(spacing)>100000))
    throw CadError("INVALID_PARAMETER","Loft Z spacing must be non-zero and within 100000 mm.");
  BRepOffsetAPI_ThruSections builder(true,feature.StringParameters.at("loftRuled")=="true");
  builder.SetMutableInput(false);builder.CheckCompatibility(true);
  std::vector<LoftProfile> placed;std::string proof;bool proven=true;double firstZ=0;
  for(std::size_t i=0;i<profiles.size();++i){
    auto section=profiles[i];profileWire(section.Face);
    GProp_GProps properties;BRepGProp::SurfaceProperties(section.Face,properties);
    if(i==0)firstZ=properties.CentreOfMass().Z();
    if(placement=="z-spacing"){
      gp_Trsf shift;shift.SetTranslation(gp_Vec(0,0,firstZ+static_cast<double>(i)*spacing-properties.CentreOfMass().Z()));
      BRepBuilderAPI_Transform transform(section.Face,shift,true);transform.Build();
      const auto shape=transform.Shape();section.Names=TopologyNaming::Propagate(section.Face,section.Names,shape,transform);section.Face=TopoDS::Face(shape);
    }
    builder.AddWire(profileWire(section.Face));placed.push_back(section);
    proven=proven&&!section.Proof.empty();proof+=std::to_string(section.Proof.size())+':'+section.Proof;
  }
  builder.Build();if(!builder.IsDone())throw CadError("LOFT_BUILD_FAILED","The ordered real profiles could not be lofted. Check section positions, order and boundary compatibility.");
  const auto shape=OrientClosedSolidResult(builder.Shape());valid(shape);
  ShapeSerializer output(shape,0,"");if(builder.FirstShape().IsNull() || builder.LastShape().IsNull() || !output.Faces().Contains(builder.FirstShape()) || !output.Faces().Contains(builder.LastShape()))
    throw CadError("INVALID_RESULT","Loft did not produce the two requested end-cap Faces.");
  TopologyNames names;
  if(proven){
    TopoDS_Compound input;BRep_Builder compound;compound.MakeCompound(input);
    for(const auto& section:placed)compound.Add(input,section.Face);
    ShapeSerializer topology(input,0,"");TopologyNames sources;
    for(const auto& section:placed){ShapeSerializer local(section.Face,0,"");for(const std::string kind:{"face","edge"}){
      const auto& from=kind=="face"?local.Faces():local.Edges();const auto& into=kind=="face"?topology.Faces():topology.Edges();
      for(int i=1;i<=from.Extent();++i){const auto found=section.Names.find(kind+':'+std::to_string(i));if(found!=section.Names.end())sources[kind+':'+std::to_string(into.FindIndex(from(i)))]=found->second;}
    }}
    const auto owner=feature.Id+"/loft/"+StableDigest(proof);
    names=TopologyNaming::FeatureResult(input,sources,shape,builder,owner+(feature.StringParameters.at("loftRuled")=="true"?"/ruled":"/smooth"));
    if(!endpointCaps){
      names["face:"+std::to_string(output.Faces().FindIndex(builder.FirstShape()))]={owner+"/start-cap"};
      names["face:"+std::to_string(output.Faces().FindIndex(builder.LastShape()))]={owner+"/end-cap"};
    }
  }
  if(endpointCaps){
    // A middle section changes the lateral construction, not either end cap.
    // Each cap needs only its own complete, unique section proof plus the
    // owning feature and endpoint role; incomplete neighbours cannot lend proof.
    if(!placed.front().Proof.empty())names["face:"+std::to_string(output.Faces().FindIndex(builder.FirstShape()))]={feature.Id+"/loft/section/"+placed.front().Proof+"/start-cap"};
    if(!placed.back().Proof.empty())names["face:"+std::to_string(output.Faces().FindIndex(builder.LastShape()))]={feature.Id+"/loft/section/"+placed.back().Proof+"/end-cap"};
  }
  for(auto it=names.begin();it!=names.end();)if(it->first.rfind("edge:",0)==0)it=names.erase(it);else ++it;
  TopologyNaming::CompleteEdges(shape,names);
  return {shape,names,TopoDS::Face(builder.FirstShape()),TopoDS::Face(builder.LastShape())};
}
TopoDS_Shape BuildLegacyLoft(const std::vector<TopoDS_Shape>& sections,double spacing)
{
  if(sections.size()<2)throw CadError("INVALID_PARAMETER","Legacy Loft requires at least two Bodies.");
  BRepOffsetAPI_ThruSections builder(true,false);
  for(std::size_t i=0;i<sections.size();++i){
    Bnd_Box box;BRepBndLib::Add(sections[i],box);double xmin=-5,ymin=-5,zmin=0,xmax=5,ymax=5,zmax=0;
    if(!box.IsVoid())box.Get(xmin,ymin,zmin,xmax,ymax,zmax);
    if(std::abs(xmax-xmin)<1e-6)xmax=xmin+1;if(std::abs(ymax-ymin)<1e-6)ymax=ymin+1;
    const double z=static_cast<double>(i)*spacing;BRepBuilderAPI_MakePolygon polygon;
    polygon.Add(gp_Pnt(xmin,ymin,z));polygon.Add(gp_Pnt(xmax,ymin,z));polygon.Add(gp_Pnt(xmax,ymax,z));polygon.Add(gp_Pnt(xmin,ymax,z));polygon.Close();
    if(!polygon.IsDone())throw CadError("BUILD_FAILED","Could not rebuild a legacy Loft section.");builder.AddWire(polygon.Wire());
  }
  builder.Build();if(!builder.IsDone())throw CadError("BUILD_FAILED","Could not rebuild the legacy Loft.");const auto result=builder.Shape();valid(result);return result;
}
}
