// SPDX-License-Identifier: GPL-3.0-or-later
// Compatibility entry only; algorithm and quality code live in the formal core.
#include "DiscreteVolumeMesh.hxx"
#include "GmshSession.hxx"
#include "QualityControl.hxx"
#include "runtime/NativeResourceGuard.hxx"
#include <iostream>
#include <new>
int main(){
  try{
    std::set_new_handler(occweb::NativeResourceGuard::AllocationFailure);
    occweb::NativeResourceGuard guard(occweb::NativeResourceGuard::EnvironmentLimit("VOLUME_MESH_MEMORY_LIMIT_BYTES"));
    std::string line;char c;while(std::cin.get(c)&&c!='\n'){
      if(line.size()>=8u*1024u*1024u)throw occweb::discrete::QualityError("MESH_INPUT_LIMIT","Input exceeds 8 MiB.");line+=c;
    }
    occweb::discrete::GmshSession session;
    const auto result=occweb::discrete::CreateVolumeMesh(occweb::JsonParser(line).Parse());
    const auto wire=occweb::JsonSerialize(result);
    if(wire.size()>64u*1024u*1024u)throw occweb::discrete::QualityError("MESH_OUTPUT_LIMIT","Reply exceeds 64 MiB.");
    std::cout<<wire<<'\n';return result.At("ok").AsBoolean()?0:2;
  }catch(const occweb::NativeResourceGuardError& e){std::cerr<<e.what()<<'\n';return e.ExitCode();}
  catch(const occweb::discrete::QualityError& e){std::cout<<"{\"ok\":false,\"code\":\""<<occweb::JsonEscape(e.code)<<"\",\"error\":\""<<occweb::JsonEscape(e.what())<<"\"}\n";return 2;}
  catch(const occweb::JsonError& e){std::cout<<"{\"ok\":false,\"code\":\"MESH_INPUT_INVALID\",\"error\":\""<<occweb::JsonEscape(e.what())<<"\"}\n";return 2;}
  catch(const std::exception& e){std::cout<<"{\"ok\":false,\"code\":\"MESH_RESEARCH_FAILED\",\"error\":\""<<occweb::JsonEscape(e.what())<<"\"}\n";return 3;}
  catch(const std::string& e){std::cout<<"{\"ok\":false,\"code\":\"GMSH_RESEARCH_FAILED\",\"error\":\""<<occweb::JsonEscape(e)<<"\"}\n";return 3;}
}
