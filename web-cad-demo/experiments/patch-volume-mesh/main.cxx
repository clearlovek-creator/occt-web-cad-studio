// SPDX-License-Identifier: GPL-3.0-or-later
// Compatibility entry only; the algorithm is owned by the formal mesh core.
#include "DiscreteVolumeMesh.hxx"
#include "GmshSession.hxx"
#include "runtime/NativeResourceGuard.hxx"
#include <iostream>
#include <new>
int main(){try{
  std::set_new_handler(occweb::NativeResourceGuard::AllocationFailure);
  occweb::NativeResourceGuard guard(occweb::NativeResourceGuard::EnvironmentLimit("VOLUME_MESH_MEMORY_LIMIT_BYTES"));
  std::string line;char c;while(std::cin.get(c)&&c!='\n'){if(line.size()>=8u*1024u*1024u)throw std::runtime_error("Input exceeds 8 MiB.");line+=c;}
  occweb::discrete::GmshSession session;const auto result=occweb::discrete::CreatePatchedVolumeMesh(occweb::JsonParser(line).Parse());const auto wire=occweb::JsonSerialize(result);
  if(wire.size()>64u*1024u*1024u)throw std::runtime_error("Output exceeds 64 MiB.");std::cout<<wire<<'\n';return result.At("ok").AsBoolean()?0:2;
}catch(const occweb::NativeResourceGuardError& e){std::cerr<<e.what()<<'\n';return e.ExitCode();}
catch(const std::exception& e){std::cout<<"{\"ok\":false,\"code\":\"MESH_PATCH_FAILED\",\"error\":\""<<occweb::JsonEscape(e.what())<<"\"}\n";return 3;}
catch(const std::string& e){std::cout<<"{\"ok\":false,\"code\":\"GMSH_PATCH_FAILED\",\"error\":\""<<occweb::JsonEscape(e)<<"\"}\n";return 3;}}
