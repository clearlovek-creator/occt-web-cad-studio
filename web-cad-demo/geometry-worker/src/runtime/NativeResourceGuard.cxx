#include "NativeResourceGuard.hxx"
#include <atomic>
#include <cstdlib>
#include <limits>
#include <new>
#include <thread>
#ifdef _WIN32
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#endif

namespace occweb {
std::uint64_t NativeResourceGuard::EnvironmentLimit(const char* variable){
  const char* value=std::getenv(variable);
  if(!value)return DefaultBytes;
  std::uint64_t result=0;std::size_t length=0;
  for(const char* p=value;*p;++p){
    if(++length>20||*p<'0'||*p>'9'||result>MaximumBytes/10)
      throw NativeResourceGuardError(std::string("Invalid ")+variable+".",ConfigurationExitCode);
    result=result*10+static_cast<unsigned>(*p-'0');
  }
  if(!length||result<MinimumBytes||result>MaximumBytes)
    throw NativeResourceGuardError("Geometry worker commit limit must be between 128 MiB and 8 GiB.",ConfigurationExitCode);
  return result;
}
#ifdef _WIN32
namespace {
std::atomic<HANDLE> activeJob{nullptr};
class Handle {
public:
  explicit Handle(HANDLE handle=nullptr):myHandle(handle){}
  ~Handle(){if(myHandle&&myHandle!=INVALID_HANDLE_VALUE)CloseHandle(myHandle);}
  Handle(const Handle&)=delete;Handle& operator=(const Handle&)=delete;
  HANDLE Get()const{return myHandle;}
private:
  HANDLE myHandle;
};
void check(bool ok,const char* operation){
  if(!ok)throw NativeResourceGuardError(std::string(operation)+" failed (Win32 "+std::to_string(GetLastError())+").",NativeResourceGuard::UnavailableExitCode);
}
[[noreturn]] void stopForMemory(bool limit){
  // No allocation, iostream or synchronous pipe I/O on an OOM path. Even a
  // fixed WriteFile(stderr) can block forever behind a full diagnostic pipe.
  // The supervising Gateway logs the authoritative exit code after OS exit.
  const UINT code=limit?NativeResourceGuard::LimitExitCode:NativeResourceGuard::AllocationExitCode;
  if(const auto job=activeJob.load())TerminateJobObject(job,code);
  TerminateProcess(GetCurrentProcess(),code);
  std::_Exit(static_cast<int>(code));
}
}
struct NativeResourceGuard::Impl {
  Handle Job{CreateJobObjectW(nullptr,nullptr)};
  Handle Port{CreateIoCompletionPort(INVALID_HANDLE_VALUE,nullptr,0,1)};
  std::uint64_t Limit;
  std::atomic<bool> Stopping{false};
  std::thread Monitor;
  std::new_handler Previous=nullptr;
  explicit Impl(std::uint64_t bytes):Limit(bytes){
    if(bytes<MinimumBytes||bytes>MaximumBytes||bytes>std::numeric_limits<SIZE_T>::max())
      throw NativeResourceGuardError("Unsupported geometry memory limit.",ConfigurationExitCode);
    check(Job.Get()!=nullptr,"CreateJobObject");check(Port.Get()!=nullptr,"CreateIoCompletionPort");
    if(activeJob.load())throw NativeResourceGuardError("A native resource guard is already active.",UnavailableExitCode);
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
    limits.BasicLimitInformation.LimitFlags=JOB_OBJECT_LIMIT_PROCESS_MEMORY|JOB_OBJECT_LIMIT_JOB_MEMORY;
    limits.ProcessMemoryLimit=static_cast<SIZE_T>(bytes);limits.JobMemoryLimit=static_cast<SIZE_T>(bytes);
    check(SetInformationJobObject(Job.Get(),JobObjectExtendedLimitInformation,&limits,sizeof(limits))!=0,"SetInformationJobObject(commit)");
    JOBOBJECT_ASSOCIATE_COMPLETION_PORT completion{};completion.CompletionKey=this;completion.CompletionPort=Port.Get();
    check(SetInformationJobObject(Job.Get(),JobObjectAssociateCompletionPortInformation,&completion,sizeof(completion))!=0,"SetInformationJobObject(completion)");
    check(AssignProcessToJobObject(Job.Get(),GetCurrentProcess())!=0,"AssignProcessToJobObject");
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION verified{};
    check(QueryInformationJobObject(Job.Get(),JobObjectExtendedLimitInformation,&verified,sizeof(verified),nullptr)!=0,"QueryInformationJobObject");
    if((verified.BasicLimitInformation.LimitFlags&limits.BasicLimitInformation.LimitFlags)!=limits.BasicLimitInformation.LimitFlags
        ||verified.ProcessMemoryLimit!=bytes||verified.JobMemoryLimit!=bytes)
      throw NativeResourceGuardError("Native commit limit could not be verified.",UnavailableExitCode);
    activeJob.store(Job.Get());Previous=std::set_new_handler(&NativeResourceGuard::AllocationFailure);
    try{Monitor=std::thread([this]{
      while(!Stopping.load()){
        DWORD message=0;ULONG_PTR key=0;LPOVERLAPPED process=nullptr;
        const BOOL ok=GetQueuedCompletionStatus(Port.Get(),&message,&key,&process,1000);
        if(Stopping.load())return;
        if(ok&&key==reinterpret_cast<ULONG_PTR>(this)
            &&(message==JOB_OBJECT_MSG_PROCESS_MEMORY_LIMIT||message==JOB_OBJECT_MSG_JOB_MEMORY_LIMIT))stopForMemory(true);
        // Hard limits remain enforced if a notification is absent. Delivery
        // itself is best effort; operator new and OCCT OOM have a fail-closed
        // allocation path rather than claiming every denied allocation notifies.
      }
    });}catch(...){std::set_new_handler(Previous);activeJob.store(nullptr);throw;}
  }
  ~Impl(){
    Stopping=true;PostQueuedCompletionStatus(Port.Get(),0,0,nullptr);if(Monitor.joinable())Monitor.join();
    std::set_new_handler(Previous);activeJob.store(nullptr);
  }
};
#else
struct NativeResourceGuard::Impl {explicit Impl(std::uint64_t){throw NativeResourceGuardError("Native commit guard is only qualified on Windows.",UnavailableExitCode);}};
#endif
NativeResourceGuard::NativeResourceGuard(std::uint64_t bytes):myImpl(std::make_unique<Impl>(bytes)){}
NativeResourceGuard::~NativeResourceGuard()=default;
std::string NativeResourceGuard::CapabilityJson()const{
#ifdef _WIN32
  return "{\"version\":1,\"basis\":\"windows-job-commit-v1\",\"processLimitBytes\":"+std::to_string(myImpl->Limit)
    +",\"jobLimitBytes\":"+std::to_string(myImpl->Limit)+",\"enforced\":true,\"failurePolicy\":\"retire-on-memory-event-or-allocator-failure-v1\"}";
#else
  return "null";
#endif
}
[[noreturn]] void NativeResourceGuard::AllocationFailure(){
#ifdef _WIN32
  stopForMemory(false);
#else
  std::_Exit(AllocationExitCode);
#endif
}
}
