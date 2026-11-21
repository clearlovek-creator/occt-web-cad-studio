#include "TopologyNaming.hxx"
#include "../presentation/ShapeSerializer.hxx"
#include "../protocol/Json.hxx"
#include "ShapeFingerprint.hxx"
#include "CadError.hxx"
#include <BRepTools_History.hxx>
#include <BRepBuilderAPI_MakeShape.hxx>
#include <NCollection_IndexedDataMap.hxx>
#include <TopExp.hxx>
#include <TopExp_Explorer.hxx>
#include <algorithm>
#include <set>
#include <sstream>

namespace
{
using namespace occweb;
std::string key(const std::string& kind, int index) { return kind + ':' + std::to_string(index); }
std::string signature(const std::vector<std::string>& values)
{
  std::string result;
  for (const auto& value : values) result += std::to_string(value.size()) + ':' + value;
  return result;
}
void merge(std::vector<std::string>& into, const std::vector<std::string>& from)
{
  into.insert(into.end(), from.begin(), from.end());
  std::sort(into.begin(), into.end()); into.erase(std::unique(into.begin(), into.end()), into.end());
}
const std::vector<std::string>& roots(const TopologyNames& names, const std::string& kind, int index)
{
  static const std::vector<std::string> empty;
  const auto found = names.find(key(kind,index)); return found == names.end() ? empty : found->second;
}
void validateContextWork(std::size_t limit)
{
  if(limit<1 || limit>1000000)throw CadError("INVALID_TOPOLOGY_CONTEXT_LIMIT","Topology context work must be between 1 and 1000000.");
}
const std::string RemoteContextBasis="adjacent-face-refinement-2-v1";
std::map<std::string,std::string> neighborhoods(const TopoDS_Shape& shape, const TopologyNames& names,
                                               std::map<std::string,bool>* complete = nullptr)
{
  ShapeSerializer topology(shape,0,"");
  NCollection_IndexedDataMap<TopoDS_Shape,NCollection_List<TopoDS_Shape>,TopTools_ShapeMapHasher> edgeFaces, vertexFaces;
  TopExp::MapShapesAndAncestors(shape,TopAbs_EDGE,TopAbs_FACE,edgeFaces);
  TopExp::MapShapesAndAncestors(shape,TopAbs_VERTEX,TopAbs_FACE,vertexFaces);
  const auto faceSet = [&](const auto& faces, int exclude)
  {
    std::vector<std::string> result;
    for(const auto& face : faces) {
      const int index=topology.Faces().FindIndex(face);if(index==exclude || index<1)continue;
      const auto& origin=roots(names,"face",index);if(!origin.empty())result.push_back(signature(origin));
    }
    std::sort(result.begin(),result.end());result.erase(std::unique(result.begin(),result.end()),result.end());return result;
  };
  std::map<std::string,std::string> result;
  const auto allNamed=[&](const auto& faces){for(const auto& face:faces)if(roots(names,"face",topology.Faces().FindIndex(face)).empty())return false;return true;};
  for(int index=1;index<=topology.Faces().Extent();index++) {
    std::vector<std::string> adjacent;bool proven=!roots(names,"face",index).empty();
    for(TopExp_Explorer edge(topology.Faces()(index),TopAbs_EDGE);edge.More();edge.Next())
      if(edgeFaces.Contains(edge.Current())){const auto& neighbors=edgeFaces.FindFromKey(edge.Current());merge(adjacent,faceSet(neighbors,index));if(complete&&!allNamed(neighbors))proven=false;}
    result[key("face",index)]=signature(adjacent);
    if(complete)(*complete)[key("face",index)]=proven;
  }
  for(int index=1;index<=topology.Edges().Extent();index++) {
    std::vector<std::string> endpoints;bool proven=!roots(names,"edge",index).empty();
    for(TopExp_Explorer vertex(topology.Edges()(index),TopAbs_VERTEX);vertex.More();vertex.Next())
      if(vertexFaces.Contains(vertex.Current())){const auto& neighbors=vertexFaces.FindFromKey(vertex.Current());endpoints.push_back(signature(faceSet(neighbors,0)));if(complete&&!allNamed(neighbors))proven=false;}
    std::sort(endpoints.begin(),endpoints.end());endpoints.erase(std::unique(endpoints.begin(),endpoints.end()),endpoints.end());
    result[key("edge",index)]=signature(endpoints);
    if(complete)(*complete)[key("edge",index)]=proven;
  }
  return result;
}

bool selectionNeighborhoodComplete(const TopoDS_Shape& shape, const TopologyNames& names,
                                   const std::string& kind, int index)
{
  if (roots(names, kind, index).empty()) return false;
  ShapeSerializer topology(shape, 0, "");
  NCollection_IndexedDataMap<TopoDS_Shape,NCollection_List<TopoDS_Shape>,TopTools_ShapeMapHasher> adjacency;
  const auto allNamed = [&](const auto& faces)
  {
    for (const auto& face : faces)
      if (roots(names, "face", topology.Faces().FindIndex(face)).empty()) return false;
    return true;
  };
  if (kind == "face")
  {
    TopExp::MapShapesAndAncestors(shape, TopAbs_EDGE, TopAbs_FACE, adjacency);
    for (TopExp_Explorer edge(topology.Faces()(index), TopAbs_EDGE); edge.More(); edge.Next())
      if (adjacency.Contains(edge.Current()) && !allNamed(adjacency.FindFromKey(edge.Current()))) return false;
  }
  else
  {
    TopExp::MapShapesAndAncestors(shape, TopAbs_VERTEX, TopAbs_FACE, adjacency);
    for (TopExp_Explorer vertex(topology.Edges()(index), TopAbs_VERTEX); vertex.More(); vertex.Next())
      if (adjacency.Contains(vertex.Current()) && !allNamed(adjacency.FindFromKey(vertex.Current()))) return false;
  }
  return true;
}

// Read-only matching context, never persisted into constructor names.
// Optional versioned selection evidence can retain its digest. Two refinement
// rounds see beyond one-ring aliases without using
// coordinates, area, enumeration order or a nearest-shape fallback.
std::map<std::string,std::string> refinedNeighborhoods(const NamedTopologyBody& body,
  const std::map<std::string,std::string>& legacy,std::size_t& work)
{
  const auto spend=[&](std::size_t count=1){if(count>work){work=0;return false;}work-=count;return true;};
  ShapeSerializer topology(body.Shape,0,"");
  const int count=topology.Faces().Extent();
  if(count<1 || count+topology.Edges().Extent()>100000 || !spend(count+topology.Edges().Extent()))return {};
  std::vector<std::string> colors(count+1);
  for(int i=1;i<=count;++i){
    const auto& origin=roots(body.Names,"face",i);if(origin.empty())return {};
    if(!spend(legacy.at(key("face",i)).size()+origin.size()))return {};
    for(const auto& value:origin)if(!spend(value.size()))return {};
    colors[i]=StableDigest(signature({signature(origin),legacy.at(key("face",i))}));
  }
  NCollection_IndexedDataMap<TopoDS_Shape,NCollection_List<TopoDS_Shape>,TopTools_ShapeMapHasher> edgeFaces,vertexFaces;
  TopExp::MapShapesAndAncestors(body.Shape,TopAbs_EDGE,TopAbs_FACE,edgeFaces);
  TopExp::MapShapesAndAncestors(body.Shape,TopAbs_VERTEX,TopAbs_FACE,vertexFaces);
  std::vector<std::set<int>> adjacent(count+1);
  for(int edge=1;edge<=edgeFaces.Extent();++edge){
    std::set<int> faces;
    for(const auto& face:edgeFaces.FindFromIndex(edge)){if(!spend())return {};faces.insert(topology.Faces().FindIndex(face));}
    for(const int a:faces)for(const int b:faces){if(!spend())return {};if(a>0&&b>0&&a!=b)adjacent[a].insert(b);}
  }
  for(int round=0;round<2;++round){
    std::vector<std::string> next(count+1);
    for(int i=1;i<=count;++i){
      if(!spend(1+64*adjacent[i].size()))return {};
      std::vector<std::string> neighbors;for(const int n:adjacent[i])neighbors.push_back(colors[n]);
      std::sort(neighbors.begin(),neighbors.end()); // Keep distinct-neighbor multiplicity.
      next[i]=StableDigest(signature({colors[i],signature(neighbors)}));
    }
    colors=std::move(next);
  }
  std::map<std::string,std::string> result;
  for(int i=1;i<=count;++i)result[key("face",i)]=colors[i];
  for(int i=1;i<=topology.Edges().Extent();++i){
    if(roots(body.Names,"edge",i).empty())continue;
    std::vector<std::string> endpoints;bool complete=true;
    NCollection_IndexedMap<TopoDS_Shape,TopTools_ShapeMapHasher> vertices;
    TopExp::MapShapes(topology.Edges()(i),TopAbs_VERTEX,vertices);
    for(int v=1;v<=vertices.Extent();++v){
      if(!vertexFaces.Contains(vertices(v))){complete=false;break;}
      std::set<int> faces;
      for(const auto& face:vertexFaces.FindFromKey(vertices(v))){if(!spend())return {};faces.insert(topology.Faces().FindIndex(face));}
      std::vector<std::string> context;
      for(const int f:faces){if(f<1){complete=false;break;}if(!spend(64))return {};context.push_back(colors[f]);}
      std::sort(context.begin(),context.end());endpoints.push_back(signature(context));
    }
    if(complete&&!endpoints.empty()){std::sort(endpoints.begin(),endpoints.end());result[key("edge",i)]=StableDigest(signature(endpoints));}
  }
  return result;
}
struct RemoteSelectionIndex
{
  bool Available=false;
  std::map<std::string,std::string> Hashes;
  std::map<std::string,std::vector<int>> Matches;
  std::set<std::string> Incomplete;
};
// Build once for the entire archive, not once per selected Face/Edge. Both
// kinds share one bounded refinement/indexing budget; partial indexes escape
// neither capture nor resolution.
RemoteSelectionIndex remoteSelectionIndex(const TopoDS_Shape& shape,const TopologyNames& names,
  const std::map<std::string,std::string>& neighbors,std::size_t& work)
{
  auto refined=refinedNeighborhoods({shape,names,0,""},neighbors,work);
  if(refined.empty())return {};
  ShapeSerializer topology(shape,0,"");RemoteSelectionIndex result;
  const auto spend=[&](std::size_t count){if(count>work){work=0;return false;}work-=count;return true;};
  for(const std::string kind:{"face","edge"}){
    const int count=kind=="face"?topology.Faces().Extent():topology.Edges().Extent();
    for(int i=1;i<=count;++i){
      const auto& origin=roots(names,kind,i);if(origin.empty())continue;
      const auto id=key(kind,i);const auto& neighborhood=neighbors.at(id);
      if(!spend(1+kind.size()+neighborhood.size()+64+origin.size()))return {};
      for(const auto& root:origin)if(!spend(root.size()))return {};
      const auto group=signature({kind,signature(origin),neighborhood});
      const auto context=refined.find(id);
      if(context==refined.end())result.Incomplete.insert(group);
      else result.Matches[signature({group,context->second})].push_back(i);
    }
  }
  result.Hashes=std::move(refined);result.Available=true;return result;
}
std::string archivedRemoteHash(const JsonValue& entry)
{
  const auto context=entry.Find("remoteContext");if(!context)return {};
  try{
    if(!context->IsObject()||context->GetInteger("version")!=1||context->GetString("basis")!=RemoteContextBasis||context->GetInteger("matchCount")!=1
        ||!entry.At("complete").AsBoolean()||entry.At("origins").AsArray().empty()||entry.GetInteger("neighborhoodCount")<2)
      throw JsonError("Unsupported remote topology context.");
    const auto hash=context->GetString("hash");
    if(hash.size()!=64||hash.find_first_not_of("0123456789abcdef")!=std::string::npos)throw JsonError("Invalid remote topology digest.");
    return hash;
  }catch(const JsonError&){throw CadError("INVALID_SUSPENDED_TOPOLOGY","Unsupported or incomplete suspended remote topology context.");}
}
}
namespace occweb
{
TopologyNames TopologyNaming::Seed(const TopoDS_Shape& shape, const std::string& featureId, const NamedSubshapes& roles)
{
  ShapeSerializer topology(shape,0,"");TopologyNames result;
  for(const auto& [subshape,role] : roles) {
    if(subshape.IsNull())continue;
    const bool face=subshape.ShapeType()==TopAbs_FACE;
    const int index=face?topology.Faces().FindIndex(subshape):topology.Edges().FindIndex(subshape);
    if(index>0)merge(result[key(face?"face":"edge",index)],{featureId+'/'+role});
  }
  CompleteEdges(shape,result);return result;
}
TopologyNames TopologyNaming::ImportedSource(const TopoDS_Shape& shape,const std::string& featureId,
                                             const std::string& outputBodyId,const std::string& sourceFingerprint)
{
  if(shape.IsNull() || featureId.empty() || outputBodyId.empty() || sourceFingerprint.size()!=64
     || !std::all_of(sourceFingerprint.begin(),sourceFingerprint.end(),[](char c){return (c>='0'&&c<='9')||(c>='a'&&c<='f');}))
    throw CadError("INVALID_NAMING_SOURCE","Imported topology requires a verified source fingerprint and output occurrence.");
  // Whole-part evidence prevents a changed importer part order from matching a
  // coincident subset in a different part. Distinct occurrences never share a
  // source root, even if they contain exactly the same located BRep.
  const auto context=featureId+"/imported-source-v1/"+StableDigest(signature({outputBodyId,sourceFingerprint,ShapeFingerprint(shape)}));
  ShapeSerializer topology(shape,0,"");TopologyNames result;
  for(int index=1;index<=topology.Faces().Extent();++index)
    result[key("face",index)]={context+"/face/"+ShapeFingerprint(topology.Faces()(index))};
  for(int index=1;index<=topology.Edges().Extent();++index)
    result[key("edge",index)]={context+"/edge/"+ShapeFingerprint(topology.Edges()(index))};
  return result;
}
TopologyNames TopologyNaming::Propagate(const TopoDS_Shape& before,const TopologyNames& names,
                                       const TopoDS_Shape& after,const BRepTools_History& history)
{
  ShapeSerializer oldTopology(before,0,""),newTopology(after,0,"");
  const auto remap=TopologyHistory::Build(oldTopology,newTopology,0,0,history);TopologyNames result;
  for(const auto& [source,targets]:remap) {
    const bool face=source.rfind("face-",0)==0;
    const auto kind=face?"face":"edge";
    const int sourceIndex=std::stoi(source.substr(7));
    const auto& origin=roots(names,kind,sourceIndex);if(origin.empty())continue;
    for(const auto& target:targets)merge(result[key(kind,std::stoi(target.substr(7)))],origin);
  }
  return result;
}
void TopologyNaming::Merge(TopologyNames& destination,const TopologyNames& source)
{ for(const auto& [id,origin]:source)merge(destination[id],origin); }
TopologyNames TopologyNaming::Propagate(const TopoDS_Shape& before,const TopologyNames& names,
                                       const TopoDS_Shape& after,BRepBuilderAPI_MakeShape& builder)
{
  NCollection_List<TopoDS_Shape> arguments;arguments.Append(before);
  BRepTools_History history(arguments,builder);auto result=Propagate(before,names,after,history);CompleteEdges(after,result);return result;
}

TopologyNames TopologyNaming::Restrict(const TopoDS_Shape& before,const TopologyNames& names,
                                     const TopoDS_Shape& subshape)
{
  ShapeSerializer source(before,0,""),local(subshape,0,"");TopologyNames result;
  for(int i=1;i<=local.Faces().Extent();++i)
    merge(result[key("face",i)],roots(names,"face",source.Faces().FindIndex(local.Faces()(i))));
  for(int i=1;i<=local.Edges().Extent();++i)
    merge(result[key("edge",i)],roots(names,"edge",source.Edges().FindIndex(local.Edges()(i))));
  if(local.Faces().Extent()==1){
    const int index=source.Faces().FindIndex(local.Faces()(1));
    if(index<1)return {};
    std::map<std::string,bool> complete;const auto neighbors=neighborhoods(before,names,&complete);
    const auto& origin=roots(names,"face",index);
    if(origin.empty() || !complete.at(key("face",index)))return {};
    int originCount=0,contextCount=0;
    for(int i=1;i<=source.Faces().Extent();++i)if(roots(names,"face",i)==origin){
      ++originCount;if(neighbors.at(key("face",i))==neighbors.at(key("face",index)))++contextCount;
    }
    if(contextCount!=1)return {};
    // A selected split piece may share its ancestor with another Face. Removing
    // the rest of the Body must not erase the evidence that distinguished them.
    // Keep existing unique-origin names unchanged for compatible old features.
    if(originCount>1){
      const auto context=StableDigest(signature({signature(origin),neighbors.at(key("face",index))}));
      for(auto& [unused,values]:result)if(!values.empty())values={"profile/"+context+'/'+StableDigest(signature(values))};
    }
  }
  return result;
}

TopologyNames TopologyNaming::FeatureResult(const TopoDS_Shape& before,const TopologyNames& names,
  const TopoDS_Shape& after,BRepBuilderAPI_MakeShape& builder,const std::string& featureId,
  const std::vector<TopoDS_Shape>& consumedFaces)
{
  if(featureId.empty())throw CadError("INVALID_NAMING_SOURCE","Generated topology requires an owning feature identity.");
  NCollection_List<TopoDS_Shape> arguments;arguments.Append(before);
  BRepTools_History history(arguments,builder);
  auto result=Propagate(before,names,after,history);
  ShapeSerializer input(before,0,""),output(after,0,"");
  std::map<std::string,bool> sourceComplete;
  const auto sourceNeighbors=neighborhoods(before,names,&sourceComplete);
  std::map<std::string,int> sourceMultiplicity;
  const auto sourceBasis=[&](const std::string& kind,int index){return signature({signature(roots(names,kind,index)),sourceNeighbors.at(key(kind,index))});};
  for(const auto& [id,proven]:sourceComplete)if(proven){const auto kind=id.substr(0,id.find(':'));const int index=std::stoi(id.substr(id.find(':')+1));++sourceMultiplicity[kind+'/'+sourceBasis(kind,index)];}
  const auto sourceProof=[&](const std::string& kind,int index)->std::string{
    const auto id=key(kind,index);if(!sourceComplete.at(id))return {};
    const auto basis=sourceBasis(kind,index);return sourceMultiplicity.at(kind+'/'+basis)==1?basis:std::string();
  };
  std::set<int> incomplete;
  // A shell opening consumes a face. The kernel calls its new rim Modified,
  // but that rim is NOT the former whole face. Scope this replacement to the
  // feature/generator so a different opening cannot resurrect a rim property
  // on the now-retained uncut face at the old side of the body.
  for(const auto& consumed:consumedFaces)
  {
    const int sourceIndex=input.Faces().FindIndex(consumed);
    if(sourceIndex<1)throw CadError("INVALID_NAMING_SOURCE","Consumed face is not part of the feature input.");
    const auto& origin=roots(names,"face",sourceIndex);
    for(const auto& modified:history.Modified(consumed))
    {
      const int index=output.Faces().FindIndex(modified);if(index<1 || modified.IsSame(consumed))continue;
      const auto proof=sourceProof("face",sourceIndex);
      if(proof.empty()){incomplete.insert(index);continue;}
      auto& values=result[key("face",index)];
      values.erase(std::remove_if(values.begin(),values.end(),[&](const auto& value){return std::find(origin.begin(),origin.end(),value)!=origin.end();}),values.end());
      merge(values,{featureId+"/replacement-face/from-face/"+StableDigest(proof)});
    }
  }
  const auto generated=[&](const TopoDS_Shape& source,const std::string& kind,const std::string& proof)
  {
    for(const auto& shape:history.Generated(source))
      for(TopExp_Explorer face(shape,TopAbs_FACE);face.More();face.Next())
      {
        const int index=output.Faces().FindIndex(face.Current());
        if(index<1 || input.Faces().Contains(face.Current()))continue;
        if(proof.empty())incomplete.insert(index);
        else merge(result[key("face",index)],{featureId+"/generated-face/from-"+kind+"/"+StableDigest(proof)});
      }
  };
  for(int i=1;i<=input.Faces().Extent();++i)
  {
    const auto& source=input.Faces()(i);
    const auto proof=sourceProof("face",i);generated(source,"face",proof);
    // Offsetting/thickening may retain the original skin AND modify a second
    // skin from it. Only the kernel's identity/history distinguishes these.
    if(output.Faces().Contains(source))
      for(const auto& modified:history.Modified(source))
      {
        const int index=output.Faces().FindIndex(modified);
        if(index>0 && !modified.IsSame(source)){
          if(proof.empty())incomplete.insert(index);
          else merge(result[key("face",index)],{featureId+"/modified-skin/"+StableDigest(proof)});
        }
      }
  }
  for(int i=1;i<=input.Edges().Extent();++i)generated(input.Edges()(i),"edge",sourceProof("edge",i));
  // Simple thickening exposes the offset boundary edges, but not its joining
  // walls. A wall is proven by being the UNIQUE result Face incident to an
  // original/modified boundary edge and its kernel-generated parallel edge.
  // This is exact topology incidence, never distance, area or enumeration.
  NCollection_IndexedDataMap<TopoDS_Shape,NCollection_List<TopoDS_Shape>,TopTools_ShapeMapHasher> outputEdgeFaces;
  TopExp::MapShapesAndAncestors(after,TopAbs_EDGE,TopAbs_FACE,outputEdgeFaces);
  std::map<int,std::vector<std::string>> bridges;
  for(int i=1;i<=input.Edges().Extent();++i)
  {
    const auto& source=input.Edges()(i);std::vector<TopoDS_Shape> starts;
    if(output.Edges().Contains(source))starts.push_back(source);
    for(const auto& modified:history.Modified(source))if(output.Edges().Contains(modified))starts.push_back(modified);
    for(const auto& image:history.Generated(source))
    {
      if(!output.Edges().Contains(image) || !outputEdgeFaces.Contains(image))continue;
      for(const auto& start:starts)
      {
        if(start.IsSame(image) || !outputEdgeFaces.Contains(start))continue;
        std::set<int> common;
        for(const auto& a:outputEdgeFaces.FindFromKey(start))for(const auto& b:outputEdgeFaces.FindFromKey(image))
          if(a.IsSame(b))common.insert(output.Faces().FindIndex(a));
        if(common.size()!=1 || *common.begin()<1)continue;
        const int index=*common.begin();const auto proof=sourceProof("edge",i);
        if(proof.empty())incomplete.insert(index);
        else merge(bridges[index],{featureId+"/bridge-face/from-edge/"+StableDigest(proof)});
      }
    }
  }
  for(const auto& [index,origin]:bridges)
    if(roots(result,"face",index).empty() && !incomplete.count(index))result[key("face",index)]=origin;
  NCollection_IndexedMap<TopoDS_Shape,TopTools_ShapeMapHasher> vertices;
  TopExp::MapShapes(before,TopAbs_VERTEX,vertices);
  NCollection_IndexedDataMap<TopoDS_Shape,NCollection_List<TopoDS_Shape>,TopTools_ShapeMapHasher> vertexFaces,vertexEdges;
  TopExp::MapShapesAndAncestors(before,TopAbs_VERTEX,TopAbs_FACE,vertexFaces);
  TopExp::MapShapesAndAncestors(before,TopAbs_VERTEX,TopAbs_EDGE,vertexEdges);
  std::vector<std::string> vertexProofs;std::map<std::string,int> vertexMultiplicity;
  for(int i=1;i<=vertices.Extent();++i)
  {
    const auto& vertex=vertices(i);std::vector<std::string> origin;bool complete=true;
    if(vertexFaces.Contains(vertex))for(const auto& face:vertexFaces.FindFromKey(vertex))
    {
      const auto value=sourceProof("face",input.Faces().FindIndex(face));
      if(value.empty())complete=false;else merge(origin,{"face/"+value});
    }
    if(vertexEdges.Contains(vertex))for(const auto& edge:vertexEdges.FindFromKey(vertex))
    {
      const auto value=sourceProof("edge",input.Edges().FindIndex(edge));
      if(value.empty())complete=false;else merge(origin,{"edge/"+value});
    }
    const auto proof=complete&&!origin.empty()?signature(origin):std::string();vertexProofs.push_back(proof);if(!proof.empty())++vertexMultiplicity[proof];
  }
  for(int i=1;i<=vertices.Extent();++i){const auto& proof=vertexProofs[i-1];generated(vertices(i),"vertex",!proof.empty()&&vertexMultiplicity.at(proof)==1?proof:std::string());}
  // A known parent must never hide an unnamed co-generator.
  for(const int index:incomplete)result.erase(key("face",index));
  CompleteEdges(after,result);
  return result;
}
void TopologyNaming::CompleteEdges(const TopoDS_Shape& shape,TopologyNames& names)
{
  ShapeSerializer topology(shape,0,"");
  NCollection_IndexedDataMap<TopoDS_Shape,NCollection_List<TopoDS_Shape>,TopTools_ShapeMapHasher> edgeFaces;
  TopExp::MapShapesAndAncestors(shape,TopAbs_EDGE,TopAbs_FACE,edgeFaces);
  for(int index=1;index<=topology.Edges().Extent();index++) {
    if(!roots(names,"edge",index).empty() || !edgeFaces.Contains(topology.Edges()(index)))continue;
    std::vector<std::string> adjacent;bool complete=true;
    for(const auto& face:edgeFaces.FindFromKey(topology.Edges()(index))) {
      const auto& origin=roots(names,"face",topology.Faces().FindIndex(face));
      if(origin.empty()){complete=false;break;}adjacent.push_back(signature(origin));
    }
    std::sort(adjacent.begin(),adjacent.end());adjacent.erase(std::unique(adjacent.begin(),adjacent.end()),adjacent.end());
    if(complete && !adjacent.empty())names[key("edge",index)]={"boundary/"+signature(adjacent)};
  }
}
TopologyNames TopologyNaming::SweepResult(const TopoDS_Shape& profile,const TopologyNames& names,
  const TopoDS_Shape& after,BRepBuilderAPI_MakeShape& builder,const std::string& featureId,
  const TopoDS_Shape& first,const TopoDS_Shape& last)
{
  auto result=FeatureResult(profile,names,after,builder,featureId);
  ShapeSerializer input(profile,0,""),output(after,0,"");
  std::map<std::string,bool> complete;const auto neighbors=neighborhoods(profile,names,&complete);
  std::string proof;
  if(input.Faces().Extent()==1 && complete.at(key("face",1)))
    proof=StableDigest(signature({signature(roots(names,"face",1)),neighbors.at(key("face",1))}));
  const int start=output.Faces().FindIndex(first),end=output.Faces().FindIndex(last);
  // The kernel identifies the endpoints. Never infer a cap from its position,
  // surface type or output enumeration. A closed revolution has no cap faces.
  if(start>0)result.erase(key("face",start));
  if(end>0)result.erase(key("face",end));
  if(!proof.empty() && (start<1 || end<1 || start!=end)){
    if(start>0)result[key("face",start)]={featureId+"/start-cap/"+proof};
    if(end>0)result[key("face",end)]={featureId+"/end-cap/"+proof};
  }
  // Rebuild boundaries against the final, distinct cap identities.
  for(auto it=result.begin();it!=result.end();)if(it->first.rfind("edge:",0)==0)it=result.erase(it);else ++it;
  CompleteEdges(after,result);return result;
}
TopologyNames TopologyNaming::Instance(const TopologyNames& names,const std::string& featureId,const std::string& slot)
{
  if(featureId.empty() || slot.empty())throw CadError("INVALID_NAMING_SOURCE","Pattern instance requires a feature and logical slot.");
  TopologyNames result;
  for(const auto& [id,origin]:names)if(!origin.empty())result[id]={featureId+"/instance/"+slot+'/'+StableDigest(signature(origin))};
  return result;
}
std::string TopologyNaming::ToJson(const TopologyNames& names)
{
  std::ostringstream out;out<<'{';bool first=true;
  for(const auto& [id,origin]:names){if(!first)out<<',';first=false;out<<'"'<<JsonEscape(id)<<"\":[";for(std::size_t i=0;i<origin.size();i++){if(i)out<<',';out<<'"'<<JsonEscape(origin[i])<<'"';}out<<']';}out<<'}';return out.str();
}
BodyTopologyRemaps TopologyNaming::MatchBodies(const std::map<std::string,NamedTopologyBody>& before,
                                               const std::map<std::string,NamedTopologyBody>& after,
                                               std::size_t contextWorkLimit)
{
  validateContextWork(contextWorkLimit);
  struct Candidate {std::string Body;int Index;std::string Neighborhood;};
  BodyTopologyRemaps result;
  for(const auto& [id,unused]:before)result[id];
  std::map<std::string,std::map<std::string,std::string>> oldNeighbors,newNeighbors;
  for(const auto& [id,body]:before)oldNeighbors[id]=neighborhoods(body.Shape,body.Names);
  for(const auto& [id,body]:after)newNeighbors[id]=neighborhoods(body.Shape,body.Names);
  std::map<std::string,std::map<std::string,std::string>> oldRefined,newRefined;
  const auto refined=[&](const std::string& id,const auto& bodies,const auto& neighbors,auto& cache,const std::string& kind,int index){
    auto found=cache.find(id);if(found==cache.end())found=cache.emplace(id,refinedNeighborhoods(bodies.at(id),neighbors.at(id),contextWorkLimit)).first;
    const auto context=found->second.find(key(kind,index));return context==found->second.end()?std::string():context->second;
  };
  for(const std::string kind:{"face","edge"}) {
    std::map<std::string,std::vector<Candidate>> oldGroups,newGroups;
    std::map<std::string,std::pair<int,int>> oldCoverage,newCoverage;
    const auto collect=[&](const auto& bodies,const auto& neighbors,auto& groups,auto& coverage,bool old){
      for(const auto& [id,body]:bodies){ShapeSerializer topology(body.Shape,body.Revision,id);const int count=kind=="face"?topology.Faces().Extent():topology.Edges().Extent();
        auto& covered=coverage[body.Context];covered.second+=count;
        for(int i=1;i<=count;i++){
          if(old)result[id][id][kind+'-'+std::to_string(body.Revision)+'-'+std::to_string(i)];
          const auto& origin=roots(body.Names,kind,i);if(origin.empty())continue;covered.first++;
          groups[body.Context+'|'+signature(origin)].push_back({id,i,neighbors.at(id).at(key(kind,i))});
        }
      }
    };
    collect(before,oldNeighbors,oldGroups,oldCoverage,true);collect(after,newNeighbors,newGroups,newCoverage,false);
    for(const auto& [primary,sources]:oldGroups){
      const auto matches=newGroups.find(primary);if(matches==newGroups.end())continue;
      std::map<std::string,int> oldContextCount,newContextCount;
      bool contextsComputed=false,contextsComplete=true;
      const auto prepareContexts=[&](){
        if(contextsComputed)return;contextsComputed=true;
        for(const auto& source:sources){const auto value=refined(source.Body,before,oldNeighbors,oldRefined,kind,source.Index);if(value.empty()){contextsComplete=false;return;}++oldContextCount[signature({source.Neighborhood,value})];}
        for(const auto& destination:matches->second){const auto value=refined(destination.Body,after,newNeighbors,newRefined,kind,destination.Index);if(value.empty()){contextsComplete=false;return;}++newContextCount[signature({destination.Neighborhood,value})];}
      };
      for(const auto& source:sources){const auto& oldBody=before.at(source.Body);const auto oc=oldCoverage[oldBody.Context],nc=newCoverage[oldBody.Context];if(oc.first!=oc.second || nc.first!=nc.second)continue;
        int equivalent=0;for(const auto& sibling:sources)if(sibling.Neighborhood==source.Neighborhood)equivalent++;
        for(const auto& destination:matches->second){
          bool proven=sources.size()==1 || (equivalent==1 && destination.Neighborhood==source.Neighborhood);
          if(!proven && equivalent>1 && destination.Neighborhood==source.Neighborhood){
            prepareContexts();
            if(contextsComplete){const auto a=refined(source.Body,before,oldNeighbors,oldRefined,kind,source.Index),b=refined(destination.Body,after,newNeighbors,newRefined,kind,destination.Index);const auto context=signature({source.Neighborhood,a});proven=!a.empty()&&a==b&&oldContextCount[context]==1&&newContextCount[context]==1;}
          }
          if(proven){
            const auto& newBody=after.at(destination.Body);
            result[source.Body][destination.Body][kind+'-'+std::to_string(oldBody.Revision)+'-'+std::to_string(source.Index)]
              .push_back(kind+'-'+std::to_string(newBody.Revision)+'-'+std::to_string(destination.Index));
          }
        }
      }
    }
  }
  return result;
}
TopologyNames TopologyNaming::FromJson(const JsonValue& value)
{
  TopologyNames result;for(const auto& [id,origins]:value.AsObject())for(const auto& origin:origins.AsArray())merge(result[id],{origin.AsString()});return result;
}
std::string TopologyNaming::CoverageJson(const TopologyNames& names)
{
  int faces=0,edges=0;for(const auto& [id,origins]:names)if(!origins.empty()){if(id.rfind("face:",0)==0)faces++;else if(id.rfind("edge:",0)==0)edges++;}
  return "{\"version\":1,\"namedFaceCount\":"+std::to_string(faces)+",\"namedEdgeCount\":"+std::to_string(edges)+"}";
}

std::string TopologyNaming::CaptureSelection(const TopoDS_Shape& shape, const TopologyNames& names,
                                            const std::string& kind, int index,std::size_t contextWorkLimit)
{
  validateContextWork(contextWorkLimit);
  ShapeSerializer topology(shape, 0, "");
  const int count = kind == "face" ? topology.Faces().Extent() : kind == "edge" ? topology.Edges().Extent() : 0;
  if (index < 1 || index > count) throw CadError("INVALID_SELECTION", "Cannot record a missing Face or Edge selection.");
  const auto neighbors = neighborhoods(shape, names);
  const auto& origin = roots(names, kind, index);
  const auto& neighborhood = neighbors.at(key(kind, index));
  int originCount = 0, neighborhoodCount = 0;
  for (int i = 1; i <= count; ++i)
    if (roots(names, kind, i) == origin)
    {
      ++originCount;
      if (neighbors.at(key(kind, i)) == neighborhood) ++neighborhoodCount;
    }
  const bool complete=selectionNeighborhoodComplete(shape,names,kind,index);
  JsonValue remote;
  if(complete&&!origin.empty()&&neighborhoodCount>1){
    const auto refined=refinedNeighborhoods({shape,names,0,""},neighbors,contextWorkLimit);
    const auto selected=refined.find(key(kind,index));
    if(selected!=refined.end()){
      int matches=0;bool proved=true;
      for(int i=1;i<=count;++i)if(roots(names,kind,i)==origin&&neighbors.at(key(kind,i))==neighborhood){
        const auto candidate=refined.find(key(kind,i));if(candidate==refined.end()){proved=false;break;}
        if(candidate->second==selected->second)++matches;
      }
      if(proved&&matches==1){remote=JsonValue::MakeObject();remote.ChangeObject()["version"]=JsonValue(1.0);remote.ChangeObject()["basis"]=JsonValue(RemoteContextBasis);remote.ChangeObject()["hash"]=JsonValue(selected->second);remote.ChangeObject()["matchCount"]=JsonValue(1.0);}
    }
  }
  std::ostringstream out;
  out << "{\"version\":1,\"kind\":\"" << kind << "\",\"index\":" << index
      << ",\"complete\":" << (complete ? "true" : "false")
      << ",\"fingerprint\":\"" << ShapeFingerprint(shape) << "\",\"originCount\":" << originCount
      << ",\"neighborhoodCount\":" << neighborhoodCount << ",\"neighborhood\":\"" << JsonEscape(neighborhood)
      << "\",\"origins\":[";
  for (std::size_t i = 0; i < origin.size(); ++i) { if (i) out << ','; out << '"' << JsonEscape(origin[i]) << '"'; }
  out << ']';if(!remote.IsNull())out<<",\"remoteContext\":"<<JsonSerialize(remote);out<<'}';
  return out.str();
}

int TopologyNaming::ResolveSelection(const TopoDS_Shape& shape, const TopologyNames& names,
                                    const std::string& selector,std::size_t contextWorkLimit)
{
  validateContextWork(contextWorkLimit);
  const auto stored = JsonParser(selector).Parse();
  const std::string kind = stored.GetString("kind");
  if (stored.GetInteger("version") != 1 || (kind != "face" && kind != "edge"))
    throw CadError("INVALID_SELECTION_REFERENCE", "Unsupported persistent selection reference.");
  const auto remote=stored.Find("remoteContext");std::string remoteHash;
  if(remote){
    try{
      if(!remote->IsObject()||remote->GetInteger("version")!=1||remote->GetString("basis")!=RemoteContextBasis||remote->GetInteger("matchCount")!=1||stored.GetInteger("neighborhoodCount")<2||stored.GetInteger("originCount")<stored.GetInteger("neighborhoodCount")||!stored.At("complete").AsBoolean())throw JsonError("Unsupported remote topology context.");
      remoteHash=remote->GetString("hash");if(remoteHash.size()!=64||remoteHash.find_first_not_of("0123456789abcdef")!=std::string::npos)throw JsonError("Invalid remote topology digest.");
    }catch(const JsonError&){throw CadError("INVALID_SELECTION_REFERENCE","Unsupported or incomplete persistent remote topology context.");}
  }
  ShapeSerializer topology(shape, 0, "");
  const int count = kind == "face" ? topology.Faces().Extent() : topology.Edges().Extent();
  if (ShapeFingerprint(shape) == stored.GetString("fingerprint"))
  {
    const int index = stored.GetInteger("index");
    if (index >= 1 && index <= count) return index;
  }
  std::vector<std::string> origin;
  for (const auto& value : stored.At("origins").AsArray()) origin.push_back(value.AsString());
  if (origin.empty() || !stored.GetBooleanOr("complete", false)) throw CadError("FEATURE_SELECTION_UNRESOLVED", "Input geometry changed and this selection has no complete proven generating identity. Reselect or recreate the feature.");
  const auto neighbors = neighborhoods(shape, names);
  std::vector<int> candidates;
  for (int i = 1; i <= count; ++i)
    if (roots(names, kind, i) == origin && neighbors.at(key(kind, i)) == stored.GetString("neighborhood")
        && selectionNeighborhoodComplete(shape, names, kind, i))
      candidates.push_back(i);
  if(stored.GetInteger("neighborhoodCount")==1&&candidates.size()==1)return candidates.front();
  if(remote&&!candidates.empty()){
    const auto contexts=refinedNeighborhoods({shape,names,0,""},neighbors,contextWorkLimit);
    int selected=0,matches=0;bool complete=true;
    for(const int candidate:candidates){const auto found=contexts.find(key(kind,candidate));if(found==contexts.end()){complete=false;break;}if(found->second==remoteHash){selected=candidate;++matches;}}
    if(complete&&matches==1)return selected;
  }
  throw CadError("FEATURE_SELECTION_UNRESOLVED", "The selected Face or Edge disappeared, split, or became ambiguous. No index fallback was applied; reselect or recreate the feature.");
}
std::string TopologyNaming::SelectionProof(const TopoDS_Shape& shape,const TopologyNames& names,const std::string& kind,int index)
{
  const auto captured=JsonParser(CaptureSelection(shape,names,kind,index)).Parse();
  if(!captured.GetBooleanOr("complete",false) || captured.GetInteger("neighborhoodCount")!=1)return {};
  return StableDigest(signature({signature(roots(names,kind,index)),captured.GetString("neighborhood")}));
}

JsonValue TopologyNaming::CaptureSelectionSet(const TopoDS_Shape& shape,const TopologyNames& names,std::size_t contextWorkLimit)
{
  validateContextWork(contextWorkLimit);
  ShapeSerializer topology(shape,0,"");
  if(topology.Faces().Extent()+topology.Edges().Extent()>100000)
    throw CadError("SUSPENDED_TOPOLOGY_LIMIT","Recovery evidence exceeds 100000 Face/Edge entries; the feature was not suppressed.");
  std::map<std::string,bool> complete;
  const auto neighbors=neighborhoods(shape,names,&complete);
  RemoteSelectionIndex remote;bool remoteAnalyzed=false;
  JsonValue result=JsonValue::MakeObject(),entries=JsonValue::MakeObject();
  result.ChangeObject()["version"]=JsonValue(1.0);
  result.ChangeObject()["fingerprint"]=JsonValue(ShapeFingerprint(shape));
  result.ChangeObject()["namesFingerprint"]=JsonValue(StableDigest(ToJson(names)));
  result.ChangeObject()["faceCount"]=JsonValue(double(topology.Faces().Extent()));
  result.ChangeObject()["edgeCount"]=JsonValue(double(topology.Edges().Extent()));
  for(const std::string kind:{"face","edge"}){
    const int count=kind=="face"?topology.Faces().Extent():topology.Edges().Extent();
    std::map<std::string,int> originsCount,neighborhoodCount;
    for(int i=1;i<=count;++i){const auto origin=signature(roots(names,kind,i));++originsCount[origin];++neighborhoodCount[signature({origin,neighbors.at(key(kind,i))})];}
    for(int i=1;i<=count;++i){
      const auto id=key(kind,i),origin=signature(roots(names,kind,i));
      JsonValue entry=JsonValue::MakeObject(),values=JsonValue::MakeArray();
      for(const auto& root:roots(names,kind,i))values.ChangeArray().emplace_back(root);
      entry.ChangeObject()["complete"]=JsonValue(complete.at(id));
      entry.ChangeObject()["origins"]=std::move(values);
      entry.ChangeObject()["originCount"]=JsonValue(double(originsCount.at(origin)));
      entry.ChangeObject()["neighborhoodCount"]=JsonValue(double(neighborhoodCount.at(signature({origin,neighbors.at(id)}))));
      entry.ChangeObject()["neighborhood"]=JsonValue(neighbors.at(id));
      if(complete.at(id)&&!roots(names,kind,i).empty()&&entry.GetInteger("neighborhoodCount")>1){
        if(!remoteAnalyzed){remote=remoteSelectionIndex(shape,names,neighbors,contextWorkLimit);remoteAnalyzed=true;}
        const auto group=signature({kind,origin,neighbors.at(id)});
        const auto hash=remote.Hashes.find(id);
        if(remote.Available&&!remote.Incomplete.count(group)&&hash!=remote.Hashes.end()){
          const auto found=remote.Matches.find(signature({group,hash->second}));
          if(found!=remote.Matches.end()&&found->second.size()==1){
            JsonValue context=JsonValue::MakeObject();context.ChangeObject()["version"]=JsonValue(1.0);
            context.ChangeObject()["basis"]=JsonValue(RemoteContextBasis);context.ChangeObject()["hash"]=JsonValue(hash->second);
            context.ChangeObject()["matchCount"]=JsonValue(1.0);entry.ChangeObject()["remoteContext"]=std::move(context);
          }
        }
      }
      entries.ChangeObject()[id]=std::move(entry);
    }
  }
  result.ChangeObject()["entries"]=std::move(entries);
  if(JsonSerialize(result).size()>16u*1024u*1024u)
    throw CadError("SUSPENDED_TOPOLOGY_LIMIT","Recovery evidence exceeds 16 MiB; the feature was not suppressed.");
  return result;
}

TopologyRemap TopologyNaming::ResolveSelectionSet(const TopoDS_Shape& shape,const TopologyNames& names,
                                                 const JsonValue& captured,int sourceRevision,int resultRevision,bool allowExact,std::size_t contextWorkLimit)
{
  validateContextWork(contextWorkLimit);
  const auto invalid=[](){throw CadError("INVALID_SUSPENDED_TOPOLOGY","Unsupported or incomplete suspended topology evidence.");};
  if(captured.GetInteger("version")!=1 || sourceRevision<0 || resultRevision<=sourceRevision)invalid();
  const int faces=captured.GetInteger("faceCount"),edges=captured.GetInteger("edgeCount");
  if(faces<0 || edges<0 || faces>100000 || edges>100000 || faces+edges>100000)invalid();
  const auto& entries=captured.At("entries").AsObject();
  if(entries.size()!=std::size_t(faces+edges))invalid();
  const auto fingerprint=captured.GetString("fingerprint");
  if(fingerprint.size()!=64 || fingerprint.find_first_not_of("0123456789abcdef")!=std::string::npos)invalid();
  const auto namesFingerprint=captured.GetString("namesFingerprint");
  if(namesFingerprint.size()!=64 || namesFingerprint.find_first_not_of("0123456789abcdef")!=std::string::npos)invalid();
  ShapeSerializer topology(shape,0,"");
  const bool exact=allowExact && ShapeFingerprint(shape)==fingerprint && StableDigest(ToJson(names))==namesFingerprint;
  if(exact && (faces!=topology.Faces().Extent() || edges!=topology.Edges().Extent()))invalid();
  std::map<std::string,bool> complete;
  const auto neighbors=exact?std::map<std::string,std::string>{}:neighborhoods(shape,names,&complete);
  RemoteSelectionIndex remote;bool remoteAnalyzed=false;
  TopologyRemap result;
  for(const std::string kind:{"face","edge"}){
    const int count=kind=="face"?faces:edges,currentCount=kind=="face"?topology.Faces().Extent():topology.Edges().Extent();
    std::map<std::string,int> oldOrigins,oldNeighborhoods,oldRemoteCounts;
    std::map<std::string,std::vector<int>> candidates;
    std::map<std::string,std::vector<int>> originCandidates;
    const auto entrySignature=[&](const JsonValue& entry){
      std::vector<std::string> origin;for(const auto& value:entry.At("origins").AsArray())origin.push_back(value.AsString());
      if(!std::is_sorted(origin.begin(),origin.end()) || std::adjacent_find(origin.begin(),origin.end())!=origin.end())invalid();
      return signature(origin);
    };
    for(int i=1;i<=count;++i){
      const auto found=entries.find(key(kind,i));if(found==entries.end())invalid();const auto& entry=found->second;
      if(!entry.At("complete").IsBoolean())invalid();
      const auto origin=entrySignature(entry),neighborhood=entry.GetString("neighborhood");
      ++oldOrigins[origin];++oldNeighborhoods[signature({origin,neighborhood})];
      const auto hash=archivedRemoteHash(entry);if(!hash.empty())++oldRemoteCounts[signature({origin,neighborhood,hash})];
    }
    if(!exact)for(int i=1;i<=currentCount;++i){
      const auto origin=signature(roots(names,kind,i));originCandidates[origin].push_back(i);
      if(complete.at(key(kind,i)))candidates[signature({origin,neighbors.at(key(kind,i))})].push_back(i);
    }
    for(int i=1;i<=count;++i){
      const auto& entry=entries.at(key(kind,i));const auto origin=entrySignature(entry),proof=signature({origin,entry.GetString("neighborhood")});
      if(entry.GetInteger("originCount")!=oldOrigins.at(origin) || entry.GetInteger("neighborhoodCount")!=oldNeighborhoods.at(proof))invalid();
      const auto remoteHash=archivedRemoteHash(entry);
      if(!remoteHash.empty()&&oldRemoteCounts.at(signature({origin,entry.GetString("neighborhood"),remoteHash}))!=1)invalid();
      auto& targets=result[kind+'-'+std::to_string(sourceRevision)+'-'+std::to_string(i)];
      int destination=0;
      if(exact)destination=i;
      else if(!origin.empty() && entry.At("complete").AsBoolean()){
        // Independent unique constructor roles (e.g. a Loft's unchanged cap)
        // survive changes to adjacent generated faces. Repeated origins still
        // require a unique unchanged complete neighborhood on both sides.
        const auto primary=originCandidates.find(origin);
        if(oldOrigins.at(origin)==1 && primary!=originCandidates.end() && primary->second.size()==1
           && complete.at(key(kind,primary->second.front())))destination=primary->second.front();
        else if(oldNeighborhoods.at(proof)==1){const auto found=candidates.find(proof);if(found!=candidates.end() && found->second.size()==1)destination=found->second.front();}
        else if(!remoteHash.empty()){
          if(!remoteAnalyzed){remote=remoteSelectionIndex(shape,names,neighbors,contextWorkLimit);remoteAnalyzed=true;}
          const auto group=signature({kind,origin,entry.GetString("neighborhood")});
          const auto found=remote.Matches.find(signature({group,remoteHash}));
          if(remote.Available&&!remote.Incomplete.count(group)&&found!=remote.Matches.end()&&found->second.size()==1
              &&complete.at(key(kind,found->second.front())))destination=found->second.front();
        }
      }
      if(destination)targets.push_back(kind+'-'+std::to_string(resultRevision)+'-'+std::to_string(destination));
    }
  }
  return result;
}
}
