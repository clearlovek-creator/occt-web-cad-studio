// SPDX-License-Identifier: GPL-3.0-or-later
#include "SurfaceRefinement.hxx"
#include "VolumePartition.hxx"
#include "runtime/NativeResourceGuard.hxx"
#include <CGAL/version.h>
#include <iostream>
#include <new>
#include <set>

namespace
{
using namespace occweb;
constexpr const char* Service="cad-discrete-surface-worker";
bool readLine(std::string& line)
{
  line.clear();char c;
  while(std::cin.get(c)){
    if(c=='\n')return true;
    if(line.size()>=DiscreteSurfaceLimits::RequestBytes)throw DiscreteSurfaceError("SURFACE_INPUT_LIMIT","Request exceeds 8 MiB.");
    line+=c;
  }
  return !line.empty();
}
JsonValue envelope(const std::string& requestId)
{
  auto value=JsonValue::MakeObject();auto& object=value.ChangeObject();
  object["ok"]=JsonValue(true);object["protocolVersion"]=JsonValue(1.0);
  object["requestId"]=JsonValue(requestId);object["service"]=JsonValue(std::string(Service));return value;
}
void write(const JsonValue& value)
{
  const auto wire=JsonSerialize(value);
  if(wire.size()>DiscreteSurfaceLimits::ResponseBytes)throw DiscreteSurfaceError("SURFACE_OUTPUT_LIMIT","Response exceeds 64 MiB.");
  std::cout<<wire<<'\n'<<std::flush;
  if(!std::cout)throw DiscreteSurfaceError("SURFACE_OUTPUT_UNAVAILABLE","Output pipe is unavailable.");
}
int reject(const std::string& requestId,const std::string& code,const std::string& message) noexcept
{
  try{
    auto value=envelope(requestId);value.ChangeObject()["ok"]=JsonValue(false);
    value.ChangeObject()["code"]=JsonValue(code);value.ChangeObject()["error"]=JsonValue(message.substr(0,1024));
    write(value);return 2;
  }catch(...){return 3;} // A broken output pipe must not throw out of a catch block.
}
JsonValue health(const std::string& requestId,const NativeResourceGuard& guard)
{
  auto value=envelope(requestId);auto capabilities=JsonValue::MakeObject(),surface=JsonValue::MakeObject();
  auto& s=surface.ChangeObject();s["version"]=JsonValue(1.0);s["basis"]=JsonValue(std::string("exact-autorefinement-then-iterative-snap-v1"));
  s["cgalVersion"]=JsonValue(std::string(CGAL_VERSION_STR));s["license"]=JsonValue(std::string("GPL-3.0-or-later"));
  s["maxInputTriangles"]=JsonValue(double(DiscreteSurfaceLimits::InputTriangles));s["maxOutputTriangles"]=JsonValue(double(DiscreteSurfaceLimits::OutputTriangles));
  s["maxPoints"]=JsonValue(double(DiscreteSurfaceLimits::Points));s["maxSourceReferences"]=JsonValue(double(DiscreteSurfaceLimits::OwnerReferences));
  s["maxRequestBytes"]=JsonValue(double(DiscreteSurfaceLimits::RequestBytes));s["maxResponseBytes"]=JsonValue(double(DiscreteSurfaceLimits::ResponseBytes));
  s["volumeDomainReconstruction"]=JsonValue(false);s["oneJobPerProcess"]=JsonValue(true);
  capabilities.ChangeObject()["version"]=JsonValue(1.0);capabilities.ChangeObject()["surfaceRefinement"]=std::move(surface);
  auto volume=JsonValue::MakeObject();auto& v=volume.ChangeObject();
  v["version"]=JsonValue(1.0);v["basis"]=JsonValue(std::string("exact-nef-membership-partition-shared-refined-boundary-v1"));
  v["cgalVersion"]=JsonValue(std::string(CGAL_VERSION_STR));v["license"]=JsonValue(std::string("GPL-3.0-or-later"));v["units"]=JsonValue(std::string("mm"));
  v["maxInputTriangles"]=JsonValue(double(VolumePartitionLimits::InputTriangles));v["maxOutputTriangles"]=JsonValue(double(VolumePartitionLimits::BoundaryTriangles));
  v["maxPoints"]=JsonValue(double(VolumePartitionLimits::Points));v["maxSourceSolids"]=JsonValue(double(VolumePartitionLimits::SourceSolids));
  v["maxRegions"]=JsonValue(double(VolumePartitionLimits::Regions));v["maxCells"]=JsonValue(double(VolumePartitionLimits::Cells));v["maxClassificationPairs"]=JsonValue(double(VolumePartitionLimits::ClassificationPairs));
  v["maxRequestBytes"]=JsonValue(double(DiscreteSurfaceLimits::RequestBytes));v["maxResponseBytes"]=JsonValue(double(DiscreteSurfaceLimits::ResponseBytes));
  v["oneJobPerProcess"]=JsonValue(true);v["normalMeshAdmitted"]=JsonValue(false);v["tetrahedralReady"]=JsonValue(false);
  v["sourceIdentityAuthority"]=JsonValue(std::string("caller-supplied-solid-labels-not-cad-certificates"));
  auto constrained=volume;
  constrained.ChangeObject()["basis"]=JsonValue(std::string("exact-nef-membership-with-open-sheet-constraints-v1"));
  constrained.ChangeObject()["constraintBasis"]=JsonValue(std::string("exact-triangle-closed-cell-membership-v1"));
  capabilities.ChangeObject()["constrainedVolumePartition"]=std::move(constrained);
  capabilities.ChangeObject()["volumePartition"]=std::move(volume);
  capabilities.ChangeObject()["processResources"]=JsonParser(guard.CapabilityJson()).Parse();value.ChangeObject()["capabilities"]=std::move(capabilities);return value;
}
}
int main()
{
  std::string requestId;
  try{
    std::set_new_handler(occweb::NativeResourceGuard::AllocationFailure);
    occweb::NativeResourceGuard guard(occweb::NativeResourceGuard::EnvironmentLimit("DISCRETE_SURFACE_WORKER_MEMORY_LIMIT_BYTES"));
    bool ready=false;std::string line,healthId;
    while(readLine(line)){
      requestId.clear();const auto request=occweb::JsonParser(line).Parse();
      const auto id=request.GetString("requestId");
      if(id.empty()||id.size()>128||id.find_first_not_of("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.:-")!=std::string::npos)
        throw occweb::DiscreteSurfaceError("SURFACE_REQUEST_INVALID","A bounded unique request identifier is required.");
      requestId=id;
      if(ready&&id==healthId)throw occweb::DiscreteSurfaceError("SURFACE_DUPLICATE_REQUEST","Each request must have a unique identifier.");
      if(request.GetInteger("protocolVersion")!=1)throw occweb::DiscreteSurfaceError("SURFACE_PROTOCOL_UNSUPPORTED","Only protocol version 1 is supported.");
      const auto operation=request.GetString("operation");
      for(const auto& [key,unused]:request.AsObject())if(key!="protocolVersion"&&key!="requestId"&&key!="operation"&&!((operation=="surface.refine"||operation=="volume.partition"||operation=="volume.partition-constrained")&&key=="input"))
        throw occweb::DiscreteSurfaceError("SURFACE_REQUEST_INVALID","Unknown request field.");
      if(operation=="health.ping"){
        if(ready)throw occweb::DiscreteSurfaceError("SURFACE_PROTOCOL_SEQUENCE","Only one handshake is allowed per process.");
        write(health(requestId,guard));healthId=id;ready=true;continue;
      }
      if(operation!="surface.refine"&&operation!="volume.partition"&&operation!="volume.partition-constrained")throw occweb::DiscreteSurfaceError("SURFACE_OPERATION_UNSUPPORTED","Only surface refinement and verified volume partition operations are supported.");
      if(!ready)throw occweb::DiscreteSurfaceError("SURFACE_HANDSHAKE_REQUIRED","A verified handshake must precede the surface input.");
      auto result=operation=="surface.refine"?occweb::RefineDiscreteSurface(request.At("input")):PartitionSourceVolumes(request.At("input"),operation=="volume.partition-constrained");
      auto& fields=result.ChangeObject();fields["protocolVersion"]=occweb::JsonValue(1.0);fields["requestId"]=occweb::JsonValue(requestId);
      fields["service"]=occweb::JsonValue(std::string(Service));fields["operation"]=occweb::JsonValue(operation);
      write(result);return 0;
    }
    return 0;
  }catch(const occweb::DiscreteSurfaceError& error){return reject(requestId,error.Code,error.what());}
  catch(const occweb::JsonError& error){return reject(requestId,"SURFACE_REQUEST_INVALID",error.what());}
  catch(const occweb::NativeResourceGuardError& error){std::cerr<<"Discrete surface resource guard: "<<error.what()<<'\n';return error.ExitCode();}
  catch(const std::exception& error){std::cerr<<std::string(error.what()).substr(0,8192)<<'\n';return reject(requestId,"SURFACE_RECONSTRUCTION_FAILED","Discrete surface reconstruction failed; no result was published.");}
}
