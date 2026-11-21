#include "../src/runtime/NativeResourceGuard.hxx"
#include <cstdlib>
#include <cstring>
#include <iostream>
#include <vector>
#include <thread>
#ifdef _WIN32
#include <windows.h>
#endif

int main(int argc,char** argv){
  try{
    occweb::NativeResourceGuard guard;
    std::cout<<guard.CapabilityJson()<<std::endl;
    int count=0;if(argc>=2)count=std::atoi(argv[1]);if(count<0||count>40||argc>3)return 75;
#ifdef _WIN32
    if(argc==3){
      if(std::strcmp(argv[2],"--saturate-stderr")!=0)return 75;
      std::thread([]{char bytes[65536];std::memset(bytes,'X',sizeof(bytes));for(;;){DWORD written=0;if(!WriteFile(GetStdHandle(STD_ERROR_HANDLE),bytes,sizeof(bytes),&written,nullptr))return;}}).detach();
      Sleep(100); // Give the test-only undrained pipe time to fill.
    }
    std::vector<void*> blocks;
    for(int i=0;i<count;++i){
      void* memory=VirtualAlloc(nullptr,8u*1024u*1024u,MEM_RESERVE|MEM_COMMIT,PAGE_READWRITE);
      if(!memory)occweb::NativeResourceGuard::AllocationFailure();
      std::memset(memory,0x5a,8u*1024u*1024u);blocks.push_back(memory);
      std::cout<<"{\"allocatedBytes\":"<<blocks.size()*8ull*1024*1024<<"}"<<std::endl;
    }
    for(void* block:blocks)VirtualFree(block,0,MEM_RELEASE);
#endif
    return 0;
  }catch(const occweb::NativeResourceGuardError& error){std::cerr<<error.what()<<'\n';return error.ExitCode();}
  catch(const std::bad_alloc&){occweb::NativeResourceGuard::AllocationFailure();}
  catch(const std::exception& error){std::cerr<<error.what()<<'\n';return occweb::NativeResourceGuard::UnavailableExitCode;}
}
