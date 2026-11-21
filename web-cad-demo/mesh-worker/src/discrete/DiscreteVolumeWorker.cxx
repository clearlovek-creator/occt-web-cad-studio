// SPDX-License-Identifier: GPL-3.0-or-later
#include "DiscreteVolumeWorker.hxx"
#include "DiscreteVolumeMesh.hxx"
#include "GmshSession.hxx"
#include "QualityControl.hxx"
#include "MeshCheckpoint.hxx"
#include "runtime/NativeResourceGuard.hxx"
#include <gmsh.h>
#include <iostream>
#include <new>

namespace occweb::discrete {
namespace {
using J=JsonValue;
constexpr std::size_t RequestBytes=8u*1024u*1024u,ResponseBytes=64u*1024u*1024u;
constexpr std::size_t CheckpointBytes=128u*1024u*1024u;
void check(bool valid,const char* code,const char* message){if(!valid)throw QualityError(code,message);}
bool line(std::string& value,std::size_t limit){value.clear();char c;while(std::cin.get(c)){if(c=='\n')return true;check(value.size()<limit,"MESH_INPUT_LIMIT","Request exceeds its fixed process-mode byte budget.");value+=c;}return !value.empty();}
J envelope(const std::string& id){auto value=J::MakeObject();value.ChangeObject()["ok"]=J(true);value.ChangeObject()["protocolVersion"]=J(1.);value.ChangeObject()["requestId"]=J(id);value.ChangeObject()["service"]=J(std::string("gmsh-mesh-worker"));return value;}
void write(const J& value,std::size_t limit=ResponseBytes){const auto wire=JsonSerialize(value);check(wire.size()<=limit,"MESH_OUTPUT_LIMIT","Reply exceeds its declared byte budget.");std::cout<<wire<<'\n'<<std::flush;check(bool(std::cout),"MESH_OUTPUT_UNAVAILABLE","Output pipe is unavailable.");}
int reject(const std::string& id,const std::string& code,const std::string& message) noexcept {
  try{auto result=envelope(id);result.ChangeObject()["ok"]=J(false);result.ChangeObject()["code"]=J(code);result.ChangeObject()["error"]=J(message.substr(0,1024));write(result);return 2;}catch(...){return 3;}
}
J health(const std::string& id,const NativeResourceGuard& guard,const GmshSession& session,bool checkpointMode){
  auto result=envelope(id),capabilities=J::MakeObject(),tetra=J::MakeObject();auto& t=tetra.ChangeObject();
  t["version"]=J(1.);t["basis"]=J(std::string("shared-discrete-connected-cells-gmsh-tetra-v1"));
  t["gmshVersion"]=J(session.Version());t["apiVersion"]=J(std::string(GMSH_API_VERSION));t["license"]=J(std::string("GPL-3.0-or-later"));
  t["maxInputPoints"]=J(60000.);t["maxInputTriangles"]=J(20000.);t["maxCells"]=J(128.);
  t["maxOutputPoints"]=J(100000.);t["maxTetrahedra"]=J(200000.);t["maxBoundaryTriangles"]=J(200000.);
  t["maxRequestBytes"]=J(double(RequestBytes));t["maxResponseBytes"]=J(double(ResponseBytes));
  t["qualityPolicyVersion"]=J(1.);t["maxOptimizationIterations"]=J(5.);t["oneJobPerProcess"]=J(true);
  t["normalMeshAdmitted"]=J(false);t["materialPriorityAssigned"]=J(false);t["userConfigLoaded"]=J(false);
  capabilities.ChangeObject()["version"]=J(1.);capabilities.ChangeObject()["discreteTetra"]=std::move(tetra);
  if(!checkpointMode){auto constrained=capabilities.At("discreteTetra");constrained.ChangeObject()["basis"]=J(std::string("shared-constrained-discrete-cells-gmsh-tetra-v1"));constrained.ChangeObject()["inputDomainBasis"]=J(std::string("exact-nef-membership-with-open-sheet-constraints-v1"));constrained.ChangeObject()["constraintBasis"]=J(std::string("exact-triangle-closed-cell-membership-v1"));capabilities.ChangeObject()["constrainedDiscreteTetra"]=std::move(constrained);}
  if(!checkpointMode){auto patched=capabilities.At("constrainedDiscreteTetra");patched.ChangeObject()["basis"]=J(std::string("shared-source-face-patch-gmsh-tetra-v1"));patched.ChangeObject()["patchTopologyBasis"]=J(std::string("exact-dyadic-source-face-planar-patches-v1"));patched.ChangeObject()["maxCoveragePairs"]=J(5000000.);patched.ChangeObject()["maxCoverageIndexVisits"]=J(20000000.);capabilities.ChangeObject()["patchedDiscreteTetra"]=std::move(patched);}
  if(checkpointMode){auto checkpoint=J::MakeObject();auto& c=checkpoint.ChangeObject();c["version"]=J(1.);c["basis"]=J(std::string("gmsh-linear-mesh-checkpoint-v1"));c["optimizationBasis"]=J(std::string("gmsh-checkpoint-optimization-v1"));c["snapshotBasis"]=J(std::string("bounded-gmsh-entity-mesh-v1"));c["processMode"]=J(std::string("checkpoint-only-v1"));c["gmshVersion"]=J(session.Version());c["apiVersion"]=J(std::string(GMSH_API_VERSION));c["license"]=J(std::string("GPL-3.0-or-later"));c["maxRequestBytes"]=J(double(CheckpointBytes));c["maxResponseBytes"]=J(double(CheckpointBytes));c["maxEntities"]=J(200000.);c["maxNodes"]=J(100000.);c["maxElements"]=J(1000000.);c["maxTag"]=J(1000000.);c["maxEntityTag"]=J(200000.);c["oneJobPerProcess"]=J(true);c["automaticReplay"]=J(false);c["normalMeshAdmitted"]=J(false);c["userConfigLoaded"]=J(false);capabilities.ChangeObject()["meshCheckpoint"]=std::move(checkpoint);}
  if(checkpointMode){auto patched=capabilities.At("meshCheckpoint");auto& c=patched.ChangeObject();c["basis"]=J(std::string("gmsh-patched-mesh-checkpoint-v1"));c["optimizationBasis"]=J(std::string("gmsh-patched-checkpoint-optimization-v1"));c["snapshotBasis"]=J(std::string("bounded-gmsh-embedded-entity-mesh-v2"));c["snapshotVersion"]=J(2.);c["patchTopologyBasis"]=J(std::string("exact-dyadic-source-face-planar-patches-v1"));c["inputMeshBasis"]=J(std::string("shared-source-face-patch-gmsh-tetra-v1"));c["embeddedRelationships"]=J(true);c["generationInputBinding"]=J(std::string("original-json-wire-v1"));capabilities.ChangeObject()["patchedMeshCheckpoint"]=std::move(patched);}
  capabilities.ChangeObject()["processResources"]=JsonParser(guard.CapabilityJson()).Parse();result.ChangeObject()["capabilities"]=std::move(capabilities);return result;
}
}
int RunVolumeWorker(bool checkpointMode){
  std::string requestId;
  try{
    std::set_new_handler(NativeResourceGuard::AllocationFailure);
    NativeResourceGuard guard(NativeResourceGuard::EnvironmentLimit("MESH_WORKER_MEMORY_LIMIT_BYTES"));
    GmshSession session;bool ready=false;std::string wire,healthId;
    while(line(wire,checkpointMode?CheckpointBytes:RequestBytes)){
      requestId.clear();const auto request=JsonParser(wire).Parse();const auto id=request.GetString("requestId");
      check(!id.empty()&&id.size()<=128&&id.find_first_not_of("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.:-")==std::string::npos,"MESH_REQUEST_INVALID","A bounded request identifier is required.");requestId=id;
      check(request.GetInteger("protocolVersion")==1,"MESH_PROTOCOL_UNSUPPORTED","Only protocol version 1 is supported.");
      check(!ready||id!=healthId,"MESH_DUPLICATE_REQUEST","Request identifiers must be unique.");
      const auto operation=request.GetString("operation");
      const bool patchedGeneration=operation=="mesh.discrete-patched-checkpoint",patchedOptimization=operation=="mesh.discrete-patched-optimize",checkpoint=operation=="mesh.discrete-checkpoint"||operation=="mesh.discrete-optimize"||patchedGeneration||patchedOptimization;
      check(checkpoint||wire.size()<=RequestBytes,"MESH_INPUT_LIMIT","Legacy request exceeds 8 MiB.");
      for(const auto& field:request.AsObject())check(field.first=="protocolVersion"||field.first=="requestId"||field.first=="operation"||((operation=="mesh.discrete-tetra"||operation=="mesh.discrete-constrained-tetra"||operation=="mesh.discrete-patched-tetra"||checkpoint)&&field.first=="input"),"MESH_REQUEST_INVALID","Unknown request field.");
      if(operation=="health.ping"){check(!ready,"MESH_PROTOCOL_SEQUENCE","Only one handshake is allowed.");write(health(id,guard,session,checkpointMode));healthId=id;ready=true;continue;}
      check(checkpointMode?checkpoint:(operation=="mesh.discrete-tetra"||operation=="mesh.discrete-constrained-tetra"||operation=="mesh.discrete-patched-tetra"),"MESH_OPERATION_UNSUPPORTED","Operation does not belong to this fixed single-job process mode.");
      check(ready,"MESH_HANDSHAKE_REQUIRED","A verified handshake must precede domain input.");
      const auto& input=request.At("input");check(operation=="mesh.discrete-optimize"||patchedOptimization||patchedGeneration||input.Has("quality"),"MESH_POLICY_REQUIRED","Formal tetrahedral requests require an explicit quality policy.");
      auto result=patchedGeneration?CreatePatchedVolumeCheckpoint(input):patchedOptimization?OptimizePatchedVolumeCheckpoint(input):operation=="mesh.discrete-checkpoint"?CreateVolumeCheckpoint(input):operation=="mesh.discrete-optimize"?OptimizeVolumeCheckpoint(input):operation=="mesh.discrete-constrained-tetra"?CreateConstrainedVolumeMesh(input):operation=="mesh.discrete-patched-tetra"?CreatePatchedVolumeMesh(input):CreateVolumeMesh(input);result.ChangeObject()["protocolVersion"]=J(1.);result.ChangeObject()["requestId"]=J(id);result.ChangeObject()["service"]=J(std::string("gmsh-mesh-worker"));result.ChangeObject()["operation"]=J(operation);
      write(result,checkpoint?CheckpointBytes:ResponseBytes);return result.At("ok").AsBoolean()?0:2;
    }
    return 0;
  }catch(const NativeResourceGuardError& error){std::cerr<<error.what()<<'\n';return error.ExitCode();}
  catch(const QualityError& error){return reject(requestId,error.code,error.what());}
  catch(const JsonError& error){return reject(requestId,"MESH_REQUEST_INVALID",error.what());}
  catch(const std::exception& error){std::cerr<<std::string(error.what()).substr(0,8192)<<'\n';return reject(requestId,"MESH_DISCRETE_FAILED","Discrete tetrahedral execution failed; no mesh was published.");}
  catch(const std::string& error){std::cerr<<error.substr(0,8192)<<'\n';return reject(requestId,"MESH_DISCRETE_FAILED","Discrete tetrahedral execution failed; no mesh was published.");}
}
}
