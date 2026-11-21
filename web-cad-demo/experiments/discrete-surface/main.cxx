// SPDX-License-Identifier: GPL-3.0-or-later
// Compatibility harness for the original research cases; shares the product core.
#include "SurfaceRefinement.hxx"
#include "runtime/NativeResourceGuard.hxx"
#include <iostream>
#include <new>
int main()
{
  try{
    std::set_new_handler(occweb::NativeResourceGuard::AllocationFailure);
    occweb::NativeResourceGuard memory;
    std::string line;char c;
    while(std::cin.get(c)&&c!='\n'){
      if(line.size()>=occweb::DiscreteSurfaceLimits::RequestBytes)throw occweb::DiscreteSurfaceError("SURFACE_INPUT_LIMIT","Request exceeds 8 MiB.");
      line+=c;
    }
    if(line.empty())throw occweb::DiscreteSurfaceError("INVALID_INPUT","One JSON request is required.");
    std::cout<<occweb::JsonSerialize(occweb::RefineDiscreteSurface(occweb::JsonParser(line).Parse()))<<'\n';return 0;
  }catch(const occweb::DiscreteSurfaceError& error){
    std::cout<<"{\"ok\":false,\"code\":\""<<occweb::JsonEscape(error.Code)<<"\",\"error\":\""<<occweb::JsonEscape(error.what())<<"\"}\n";return 2;
  }catch(const occweb::JsonError& error){
    std::cout<<"{\"ok\":false,\"code\":\"INVALID_INPUT\",\"error\":\""<<occweb::JsonEscape(error.what())<<"\"}\n";return 2;
  }catch(const occweb::NativeResourceGuardError& error){std::cerr<<error.what()<<'\n';return error.ExitCode();}
  catch(const std::exception& error){std::cout<<"{\"ok\":false,\"code\":\"SURFACE_RESEARCH_FAILED\",\"error\":\""<<occweb::JsonEscape(error.what())<<"\"}\n";return 3;}
}
