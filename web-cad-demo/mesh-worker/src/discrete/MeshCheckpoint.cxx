// SPDX-License-Identifier: GPL-3.0-or-later
#include "MeshCheckpoint.hxx"
#include "DiscreteVolumeMesh.hxx"
#include "LocalCoordinateFrame.hxx"
#include <gmsh.h>
#include <algorithm>
#include <cmath>
#include <map>
#include <set>

namespace occweb::discrete {
namespace {
using J=JsonValue;
void check(bool value,const char* message){if(!value)throw QualityError("MESH_CHECKPOINT_INVALID",message);}
void fields(const J& value,const std::set<std::string>& names){check(value.IsObject()&&value.AsObject().size()==names.size(),"Checkpoint fields are incomplete.");for(const auto& field:value.AsObject())check(names.count(field.first),"Unknown checkpoint field or path.");}
std::size_t tag(const J& value,std::size_t limit=1000000){const auto n=value.AsNumber();check(std::isfinite(n)&&n>0&&std::floor(n)==n&&n<=double(limit),"Checkpoint tag exceeds its bounded inventory.");return std::size_t(n);}
J numbers(const std::vector<std::size_t>& values){auto out=J::MakeArray();for(const auto value:values)out.ChangeArray().push_back(J(double(value)));return out;}
J doubles(const std::vector<double>& values){auto out=J::MakeArray();for(const auto value:values)out.ChangeArray().push_back(J(value));return out;}
J integers(const std::vector<int>& values){auto out=J::MakeArray();for(const auto value:values)out.ChangeArray().push_back(J(double(value)));return out;}
int width(int type){return type==15?1:type==1?2:type==2?3:type==4?4:0;}
int elementDimension(int type){return type==15?0:type==1?1:type==2?2:type==4?3:-1;}
bool qualitySame(const J& a,const J& b){
  for(const auto* name:{"tetraCount","lowQualityCount","lowQualityFraction","threshold","maxBadFraction","meetsRequestedQuality"})if(JsonSerialize(a.At(name))!=JsonSerialize(b.At(name)))return false;
  if(std::abs(a.GetNumber("minimumSICN")-b.GetNumber("minimumSICN"))>2e-10)return false;
  const auto& aa=a.At("perCell").AsArray();const auto& bb=b.At("perCell").AsArray();if(aa.size()!=bb.size())return false;
  for(std::size_t i=0;i<aa.size();++i){for(const auto* name:{"cellIndex","tetraCount","lowQualityCount","lowQualityFraction","meetsRequestedQuality"})if(JsonSerialize(aa[i].At(name))!=JsonSerialize(bb[i].At(name)))return false;if(std::abs(aa[i].GetNumber("minimumSICN")-bb[i].GetNumber("minimumSICN"))>2e-10)return false;}return true;
}
J originalGenerationInput(const J& saved){
  const auto wire=saved.GetString("generationInputWire");
  check(!wire.empty()&&wire.size()<=8u*1024u*1024u,"Original generation input exceeds its fixed byte budget.");
  J input;try{input=JsonParser(wire).Parse();}catch(const JsonError&){throw QualityError("MESH_CHECKPOINT_INVALID","Original generation input is not valid JSON.");}
  check(input.IsObject()&&JsonSerialize(input)==JsonSerialize(saved.At("generationInput")),"Original generation bytes disagree with the checkpoint input.");
  return input;
}
}
J checkpointJson(const MeshCheckpoint& value,bool embeddedMode){
  auto result=J::MakeObject(),entities=J::MakeArray();result.ChangeObject()["version"]=J(embeddedMode?2.:1.);result.ChangeObject()["basis"]=J(std::string(embeddedMode?"bounded-gmsh-embedded-entity-mesh-v2":"bounded-gmsh-entity-mesh-v1"));result.ChangeObject()["worldOrigin"]=doubles({value.worldOrigin[0],value.worldOrigin[1],value.worldOrigin[2]});result.ChangeObject()["pointNodeTags"]=numbers(value.pointNodeTags);
  for(const auto& entity:value.mesh.entities){auto row=J::MakeObject(),elements=J::MakeArray(),vertices=J::MakeArray();row.ChangeObject()["dimension"]=J(double(entity.dimension));row.ChangeObject()["tag"]=J(double(entity.tag));row.ChangeObject()["boundary"]=integers(entity.boundary);row.ChangeObject()["nodes"]=numbers(entity.nodes);row.ChangeObject()["coordinates"]=doubles(entity.coordinates);row.ChangeObject()["parameters"]=doubles(entity.parameters);row.ChangeObject()["types"]=integers(entity.types);for(const auto& block:entity.elements)elements.ChangeArray().push_back(numbers(block));for(const auto& block:entity.vertices)vertices.ChangeArray().push_back(numbers(block));row.ChangeObject()["elements"]=std::move(elements);row.ChangeObject()["vertices"]=std::move(vertices);if(embeddedMode){auto embedded=J::MakeArray();for(const auto& use:entity.embedded)embedded.ChangeArray().push_back(integers({use.first,use.second}));row.ChangeObject()["embedded"]=std::move(embedded);}else check(entity.embedded.empty(),"Legacy checkpoints cannot discard embedded relationships.");entities.ChangeArray().push_back(std::move(row));}
  result.ChangeObject()["entities"]=std::move(entities);return result;
}
MeshCheckpoint parseCheckpoint(const J& value,bool embeddedMode){
  fields(value,{"version","basis","worldOrigin","pointNodeTags","entities"});check(value.GetInteger("version")== (embeddedMode?2:1)&&value.GetString("basis")== (embeddedMode?"bounded-gmsh-embedded-entity-mesh-v2":"bounded-gmsh-entity-mesh-v1"),"Unsupported checkpoint version.");MeshCheckpoint result;
  const auto& origin=value.At("worldOrigin").AsArray();check(origin.size()==3,"Checkpoint world origin is invalid.");for(int i=0;i<3;++i){result.worldOrigin[i]=origin[i].AsNumber();check(std::isfinite(result.worldOrigin[i])&&std::abs(result.worldOrigin[i])<=1e12,"Checkpoint world origin is not finite and bounded.");}
  const auto& points=value.At("pointNodeTags").AsArray();check(points.size()>=4&&points.size()<=100000,"Checkpoint point inventory exceeds its budget.");for(const auto& point:points){const auto n=tag(point);check(result.pointNodeTags.empty()||n>result.pointNodeTags.back(),"Checkpoint point tags must be strictly increasing.");result.pointNodeTags.push_back(n);}
  const auto& rows=value.At("entities").AsArray();check(!rows.empty()&&rows.size()<=200000,"Checkpoint entity inventory exceeds its budget.");std::set<std::pair<int,int>> entities;std::set<std::size_t> nodes,elements;std::size_t nodeCount=0,elementCount=0,boundaryCount=0;std::pair<int,int> previous={-1,0};
  for(const auto& row:rows){
    auto names=std::set<std::string>{"dimension","tag","boundary","nodes","coordinates","parameters","types","elements","vertices"};if(embeddedMode)names.insert("embedded");fields(row,names);EntityMesh entity;entity.dimension=row.GetInteger("dimension");entity.tag=int(tag(row.At("tag"),200000));const auto identity=std::make_pair(entity.dimension,entity.tag);check(entity.dimension>=0&&entity.dimension<=3&&identity>previous&&entities.insert(identity).second,"Checkpoint entity identity/order is invalid.");previous=identity;
    std::set<int> ownBoundary;for(const auto& use:row.At("boundary").AsArray()){const auto signedTag=use.AsNumber();check(entity.dimension>0&&std::isfinite(signedTag)&&signedTag!=0&&std::floor(signedTag)==signedTag&&std::abs(signedTag)<=200000&&(entity.dimension==3||embeddedMode&&entity.dimension==2||signedTag>0),"Checkpoint boundary tag is invalid.");const int n=int(signedTag);check(ownBoundary.insert(std::abs(n)).second&&entities.count({entity.dimension-1,std::abs(n)}),"Checkpoint boundary is repeated or missing.");entity.boundary.push_back(n);check(++boundaryCount<=1000000,"Checkpoint boundary references exceed their budget.");}check(std::is_sorted(entity.boundary.begin(),entity.boundary.end()),"Checkpoint boundaries are not canonical.");
    if(embeddedMode){std::pair<int,int> old={-1,0};for(const auto& use:row.At("embedded").AsArray()){check(use.AsArray().size()==2,"Embedded relationship requires dimension and tag.");const int dimension=use.AsArray()[0].AsInteger(),n=int(tag(use.AsArray()[1],200000));const auto ref=std::make_pair(dimension,n);check(entity.dimension>=2&&dimension>=0&&dimension<entity.dimension&&ref>old&&entities.count(ref)&&!(dimension==entity.dimension-1&&ownBoundary.count(n)),"Embedded entity is repeated, missing, a boundary or dimensionally invalid.");entity.embedded.push_back(ref);old=ref;check(++boundaryCount<=1000000,"Checkpoint topology references exceed their budget.");}}
    for(const auto& node:row.At("nodes").AsArray()){const auto n=tag(node);check((entity.nodes.empty()||n>entity.nodes.back())&&nodes.insert(n).second,"Checkpoint node is repeated or unordered.");entity.nodes.push_back(n);check(++nodeCount<=100000,"Checkpoint nodes exceed their budget.");}
    for(const auto& coordinate:row.At("coordinates").AsArray()){const auto n=coordinate.AsNumber();check(std::isfinite(n)&&std::abs(n)<=2e12,"Checkpoint local coordinate is invalid.");entity.coordinates.push_back(n);}check(entity.coordinates.size()==3*entity.nodes.size(),"Checkpoint coordinates do not match its nodes.");
    for(const auto& parameter:row.At("parameters").AsArray()){const auto n=parameter.AsNumber();check(std::isfinite(n)&&std::abs(n)<=1e100,"Checkpoint parameter is invalid.");entity.parameters.push_back(n);}check(entity.parameters.empty()||entity.parameters.size()==std::size_t(entity.dimension)*entity.nodes.size(),"Checkpoint parameter dimensions do not match.");
    const auto& types=row.At("types").AsArray();const auto& ids=row.At("elements").AsArray();const auto& vertices=row.At("vertices").AsArray();check(types.size()<=1&&types.size()==ids.size()&&types.size()==vertices.size(),"Checkpoint element blocks are invalid.");
    for(std::size_t block=0;block<types.size();++block){const int type=types[block].AsInteger(),stride=width(type);check(stride&&elementDimension(type)==entity.dimension&&!ids[block].AsArray().empty(),"Only dimension-matching first-order elements are supported.");entity.types.push_back(type);entity.elements.emplace_back();entity.vertices.emplace_back();for(const auto& id:ids[block].AsArray()){const auto n=tag(id);check((entity.elements.back().empty()||n>entity.elements.back().back())&&elements.insert(n).second,"Checkpoint element tag is repeated or unordered.");entity.elements.back().push_back(n);check(++elementCount<=1000000,"Checkpoint elements exceed their budget.");}for(const auto& vertex:vertices[block].AsArray())entity.vertices.back().push_back(tag(vertex));check(entity.vertices.back().size()==std::size_t(stride)*entity.elements.back().size(),"Checkpoint element connectivity has the wrong width.");for(std::size_t i=0;i<entity.vertices.back().size();i+=stride){std::set<std::size_t> unique(entity.vertices.back().begin()+i,entity.vertices.back().begin()+i+stride);check(unique.size()==std::size_t(stride),"Checkpoint element repeats a corner.");}}
    result.mesh.entities.push_back(std::move(entity));
  }
  check(nodeCount==points.size()&&std::equal(nodes.begin(),nodes.end(),result.pointNodeTags.begin(),result.pointNodeTags.end()),"Checkpoint explicit point map is incomplete.");
  for(const auto& entity:result.mesh.entities)for(const auto& block:entity.vertices)for(const auto n:block)check(nodes.count(n),"Checkpoint element references an absent node.");return result;
}
void restoreFreshCheckpoint(const MeshCheckpoint& checkpoint,const J& generationInput,bool patched){
  gmsh::vectorpair entities;gmsh::model::getEntities(entities);check(entities.empty(),"Checkpoint restoration requires a fresh model.");
  if(patched){
    const auto origin=PreparePatchedVolumeDomain(generationInput);check(origin==checkpoint.worldOrigin,"Patched checkpoint frame differs from its original input.");
    for(const auto& entity:checkpoint.mesh.entities)if(entity.dimension<=2&&!entity.nodes.empty()){
      std::vector<double> coordinates;
      if(entity.dimension==0||!entity.parameters.empty())gmsh::model::getValue(entity.dimension,entity.tag,entity.parameters,coordinates);
      else continue;
      check(coordinates.size()==entity.coordinates.size(),"Checkpoint parameters do not describe their source geometry.");
      for(std::size_t i=0;i<coordinates.size();i+=3)check(std::hypot(coordinates[i]-entity.coordinates[i],coordinates[i+1]-entity.coordinates[i+1],coordinates[i+2]-entity.coordinates[i+2])<=1e-8,"Checkpoint node parameters disagree with the original source geometry.");
    }
    restoreMesh(checkpoint.mesh);return;
  }
  // Restore the EXPLICIT lower-dimensional topology. createTopology() may
  // allocate different curve/point tags in a fresh process, so replaying it and
  // guessing an index/coordinate mapping is not a checkpoint restoration.
  gmsh::model::add("isolated-optimization-checkpoint");
  for(const auto& entity:checkpoint.mesh.entities)if(entity.dimension<3)gmsh::model::addDiscreteEntity(entity.dimension,entity.tag,entity.boundary);
  for(const auto& entity:checkpoint.mesh.entities)if(entity.dimension<3&&!entity.nodes.empty())gmsh::model::mesh::addNodes(entity.dimension,entity.tag,entity.nodes,entity.coordinates,entity.parameters);
  for(const auto& entity:checkpoint.mesh.entities)if(entity.dimension<3&&!entity.types.empty())gmsh::model::mesh::addElements(entity.dimension,entity.tag,entity.types,entity.elements,entity.vertices);
  gmsh::model::mesh::createGeometry();
  // Preserve the original geometric-volume semantics for the optimizer, not
  // force optimization of anonymous discrete volumes. No 3D mesh is generated.
  const auto& domain=generationInput.At("domain");const auto& cells=domain.At("cells").AsArray();const auto& uses=domain.At("triangleCellUses").AsArray();
  for(std::size_t c=0;c<cells.size();++c){std::vector<int> loops;for(const auto& shell:cells[c].At("shells").AsArray()){std::vector<int> faces;for(const auto& value:shell.At("triangleIndexes").AsArray()){const auto i=std::size_t(value.AsInteger());check(i<uses.size(),"Checkpoint shell index is out of range.");int sign=0;for(const auto& use:uses[i].AsArray())if(use.GetInteger("cellIndex")==int(c))sign=use.GetInteger("orientation");check(sign==1||sign==-1,"Checkpoint shell lacks a source orientation.");faces.push_back(sign*int(i+1));}check(faces.size()>=4,"Checkpoint shell is incomplete.");loops.push_back(gmsh::model::geo::addSurfaceLoop(faces));}gmsh::model::geo::addVolume(loops,int(c+1));}
  gmsh::model::geo::synchronize();
  restoreMesh(checkpoint.mesh);
}
static J createCheckpoint(const J& request,bool patched){
  if(patched)fields(request,{"generationInput","generationInputWire"});
  const auto input=patched?originalGenerationInput(request):request;
  check(input.Has("quality"),"Checkpoint generation requires an explicit quality policy.");
  const auto controls=parseControls(input);check(!controls.method.empty(),"Checkpoint generation requires an explicit optimization request.");auto baselineInput=input;baselineInput.ChangeObject().erase("optimization");baselineInput.ChangeObject()["quality"].ChangeObject()["mode"]=J(std::string("diagnostic"));J checkpoint;
  auto baseline=patched?CreatePatchedVolumeMesh(baselineInput,&checkpoint):CreateVolumeMesh(baselineInput,&checkpoint);check(baseline.At("ok").AsBoolean(),"Unoptimized diagnostic mesh generation failed.");auto result=J::MakeObject();result.ChangeObject()["ok"]=J(true);result.ChangeObject()["basis"]=J(std::string(patched?"gmsh-patched-mesh-checkpoint-v1":"gmsh-linear-mesh-checkpoint-v1"));result.ChangeObject()["gmshVersion"]=J(std::string(GMSH_API_VERSION));result.ChangeObject()["generationInput"]=input;if(patched)result.ChangeObject()["generationInputWire"]=request.At("generationInputWire");result.ChangeObject()["baseline"]=std::move(baseline);result.ChangeObject()["checkpoint"]=std::move(checkpoint);result.ChangeObject()["normalMeshAdmitted"]=J(false);return result;
}
static J optimizeCheckpoint(const J& request,bool patched){
  fields(request,{"generationInput","checkpointResult"});const auto& input=request.At("generationInput");auto inputNames=std::set<std::string>{"domain","meshSize","quality","optimization"};if(patched)inputNames.insert("patchPlan");fields(input,inputNames);
  const auto& saved=request.At("checkpointResult");check(saved.At("ok").AsBoolean()&&saved.GetString("basis")== (patched?"gmsh-patched-mesh-checkpoint-v1":"gmsh-linear-mesh-checkpoint-v1")&&!saved.At("normalMeshAdmitted").AsBoolean(),"A raw checkpoint result of the requested family is required.");
  if(patched)check(JsonSerialize(originalGenerationInput(saved))==JsonSerialize(input),"Original generation bytes differ from the optimization input.");
  const auto controls=parseControls(input);check(!controls.method.empty(),"An explicit optimization method is required.");const auto& domain=input.At("domain");check(domain.GetString("basis")== (patched?"exact-nef-membership-with-open-sheet-constraints-v1":"exact-nef-membership-partition-shared-refined-boundary-v1"),"Checkpoint domain family differs.");
  const auto cells=domain.At("cells").AsArray().size(),surfaces=patched?input.At("patchPlan").At("patches").AsArray().size():domain.At("triangles").AsArray().size();const auto& domainPoints=domain.At("points").AsArray();check(cells>0&&cells<=128&&surfaces>=4&&surfaces<=20000&&domainPoints.size()>=4&&domainPoints.size()<=60000,"Checkpoint domain inventory exceeds its budget.");
  const auto checkpoint=parseCheckpoint(saved.At("checkpoint"),patched);const auto& origin=domainPoints.front().AsArray();check(origin.size()==3,"Checkpoint domain origin is missing.");for(int i=0;i<3;++i)check(origin[i].AsNumber()==checkpoint.worldOrigin[i],"Checkpoint frame does not match its original domain.");const LocalCoordinateFrame frame(checkpoint.worldOrigin);
  check(JsonSerialize(saved.At("generationInput"))==JsonSerialize(input),"Checkpoint generation settings or domain have changed; no reinterpretation is allowed.");ConfigureVolumeMeshOptions(input.GetNumber("meshSize"));restoreFreshCheckpoint(checkpoint,input,patched);check(captureMesh()==checkpoint.mesh,"Fresh checkpoint restoration was not exact.");
  auto baselineControls=controls;baselineControls.method.clear();baselineControls.strict=false;auto none=J::MakeObject();none.ChangeObject()["requested"]=J(false);std::vector<std::size_t> pointTags;
  const auto restored=patched?ExportPatchedVolumeMesh(input,baselineControls,none,frame,&pointTags):ExportVolumeMesh(domain,baselineControls,none,frame,&pointTags);check(restored.At("ok").AsBoolean()&&pointTags==checkpoint.pointNodeTags&&qualitySame(restored.At("quality"),saved.At("baseline").At("quality")),"Restored checkpoint quality or explicit point identities differ from the original.");
  const auto optimization=optimizeAndCheck(controls,cells,surfaces,[&frame]{frame.canonicalizeMesh();});auto mesh=patched?ExportPatchedVolumeMesh(input,controls,optimization,frame,&pointTags):ExportVolumeMesh(domain,controls,optimization,frame,&pointTags);if(!mesh.At("ok").AsBoolean())return mesh;
  auto result=J::MakeObject();result.ChangeObject()["ok"]=J(true);result.ChangeObject()["basis"]=J(std::string(patched?"gmsh-patched-checkpoint-optimization-v1":"gmsh-checkpoint-optimization-v1"));result.ChangeObject()["gmshVersion"]=J(std::string(GMSH_API_VERSION));result.ChangeObject()["mesh"]=std::move(mesh);result.ChangeObject()["pointNodeTags"]=numbers(pointTags);result.ChangeObject()["restoredExactly"]=J(true);result.ChangeObject()["normalMeshAdmitted"]=J(false);if(patched)result.ChangeObject()["embeddedTopologyUnchanged"]=J(true);return result;
}
J CreateVolumeCheckpoint(const J& request){return createCheckpoint(request,false);}
J OptimizeVolumeCheckpoint(const J& request){return optimizeCheckpoint(request,false);}
J CreatePatchedVolumeCheckpoint(const J& request){return createCheckpoint(request,true);}
J OptimizePatchedVolumeCheckpoint(const J& request){return optimizeCheckpoint(request,true);}
} // namespace occweb::discrete
