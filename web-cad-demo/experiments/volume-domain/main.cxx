// SPDX-License-Identifier: GPL-3.0-or-later
// Isolated research. No product route, release selection or CAD mutation.
#include "VolumePartition.hxx"
#include "SurfaceRefinement.hxx"
#include "runtime/NativeResourceGuard.hxx"
#include <iostream>
#include <new>
int main(){
 try{
  std::set_new_handler(occweb::NativeResourceGuard::AllocationFailure);
  occweb::NativeResourceGuard memory(occweb::NativeResourceGuard::EnvironmentLimit("VOLUME_DOMAIN_MEMORY_LIMIT_BYTES"));
  std::string line;char c;while(std::cin.get(c)&&c!='\n'){if(line.size()>=8u*1024u*1024u)throw occweb::DiscreteSurfaceError("VOLUME_INPUT_LIMIT","Input exceeds 8 MiB.");line+=c;}
  const auto result=PartitionSourceVolumes(occweb::JsonParser(line).Parse());const auto wire=occweb::JsonSerialize(result);
  if(wire.size()>64u*1024u*1024u)throw occweb::DiscreteSurfaceError("VOLUME_OUTPUT_LIMIT","Output exceeds 64 MiB.");
  std::cout<<wire<<'\n';return 0;
 }catch(const occweb::DiscreteSurfaceError& e){std::cout<<"{\"ok\":false,\"code\":\""<<occweb::JsonEscape(e.Code)<<"\",\"error\":\""<<occweb::JsonEscape(e.what())<<"\"}\n";return 2;}
 catch(const occweb::NativeResourceGuardError& e){std::cerr<<e.what()<<'\n';return e.ExitCode();}
 catch(const std::exception& e){std::cout<<"{\"ok\":false,\"code\":\"VOLUME_RESEARCH_FAILED\",\"error\":\""<<occweb::JsonEscape(e.what())<<"\"}\n";return 3;}
}
