#pragma once
#include <cstdint>
#include <memory>
#include <stdexcept>
#include <string>

namespace occweb {
class NativeResourceGuardError:public std::runtime_error {
public:
  NativeResourceGuardError(const std::string& message,int exitCode):std::runtime_error(message),myExitCode(exitCode){}
  int ExitCode()const{return myExitCode;}
private:
  int myExitCode;
};

/** Windows commit accounting, not RSS sampling or a geometry-size estimate. */
class NativeResourceGuard {
public:
  static constexpr std::uint64_t MinimumBytes=128ull*1024*1024;
  static constexpr std::uint64_t MaximumBytes=8ull*1024*1024*1024;
  static constexpr std::uint64_t DefaultBytes=2ull*1024*1024*1024;
  static constexpr int LimitExitCode=86,AllocationExitCode=87,UnavailableExitCode=88,ConfigurationExitCode=89;
  static std::uint64_t EnvironmentLimit(const char* variable="GEOMETRY_WORKER_MEMORY_LIMIT_BYTES");
  explicit NativeResourceGuard(std::uint64_t bytes=EnvironmentLimit());
  ~NativeResourceGuard();
  NativeResourceGuard(const NativeResourceGuard&)=delete;
  NativeResourceGuard& operator=(const NativeResourceGuard&)=delete;
  std::string CapabilityJson()const;
  [[noreturn]] static void AllocationFailure();
private:
  struct Impl;
  std::unique_ptr<Impl> myImpl;
};
}
