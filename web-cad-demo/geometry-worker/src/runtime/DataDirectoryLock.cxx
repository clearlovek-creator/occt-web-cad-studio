#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <tlhelp32.h>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>

namespace {
class Handle {
public:
  explicit Handle(HANDLE value = INVALID_HANDLE_VALUE) : value_(value) {}
  ~Handle() { if (value_ && value_ != INVALID_HANDLE_VALUE) CloseHandle(value_); }
  Handle(const Handle&) = delete;
  Handle& operator=(const Handle&) = delete;
  HANDLE get() const { return value_; }
  bool valid() const { return value_ && value_ != INVALID_HANDLE_VALUE; }
private:
  HANDLE value_;
};
int fail(const char* code, DWORD error = 0) {
  std::cout << "{\"ok\":false,\"code\":\"" << code << "\",\"win32Error\":" << error << "}" << std::endl;
  return 73;
}
unsigned long long timestamp(const FILETIME& value) {
  return (static_cast<unsigned long long>(value.dwHighDateTime) << 32) | value.dwLowDateTime;
}
DWORD parentPid() {
  Handle snapshot(CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0));
  if (!snapshot.valid()) return 0;
  PROCESSENTRY32W entry{}; entry.dwSize = sizeof(entry);
  if (Process32FirstW(snapshot.get(), &entry)) do {
    if (entry.th32ProcessID == GetCurrentProcessId()) return entry.th32ParentProcessID;
  } while (Process32NextW(snapshot.get(), &entry));
  return 0;
}
bool validToken(const std::wstring& value) {
  if (value.size() != 36) return false;
  for (std::size_t i = 0; i < value.size(); ++i) {
    if (i == 8 || i == 13 || i == 18 || i == 23) { if (value[i] != L'-') return false; }
    else if (std::wstring(L"0123456789abcdef").find(value[i]) == std::wstring::npos) return false;
  }
  return true;
}
void revoke(HANDLE owner, HANDLE remote) {
  if (!remote) return;
  HANDLE local = nullptr;
  // Only revoke a handle created by this invocation, never enumerate or close
  // any other process handle. The process object cannot be confused by PID reuse.
  if (DuplicateHandle(owner, remote, GetCurrentProcess(), &local, 0, FALSE,
                      DUPLICATE_CLOSE_SOURCE | DUPLICATE_SAME_ACCESS)) CloseHandle(local);
}
}

int wmain(int argc, wchar_t** argv) {
  if (argc != 4 || !validToken(argv[3])) return fail("DATA_DIRECTORY_LOCK_ARGUMENTS");
  wchar_t* end = nullptr;
  const unsigned long parsed = wcstoul(argv[2], &end, 10);
  if (!parsed || !end || *end || parsed != parentPid()) return fail("DATA_DIRECTORY_OWNER_INVALID");
  const DWORD pid = static_cast<DWORD>(parsed);
  Handle owner(OpenProcess(PROCESS_DUP_HANDLE | PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, pid));
  FILETIME ownerStart{}, selfStart{}, exit{}, kernel{}, user{};
  if (!owner.valid() || !GetProcessTimes(owner.get(), &ownerStart, &exit, &kernel, &user)
      || !GetProcessTimes(GetCurrentProcess(), &selfStart, &exit, &kernel, &user)
      || timestamp(ownerStart) > timestamp(selfStart) || WaitForSingleObject(owner.get(), 0) != WAIT_TIMEOUT)
    return fail("DATA_DIRECTORY_OWNER_INVALID", GetLastError());

  const std::wstring directory(argv[1]);
  std::vector<wchar_t> volumePath(32768);
  wchar_t fileSystem[64]{};
  if (!GetVolumePathNameW(directory.c_str(), volumePath.data(), static_cast<DWORD>(volumePath.size()))
      || GetDriveTypeW(volumePath.data()) != DRIVE_FIXED
      || !GetVolumeInformationW(volumePath.data(), nullptr, 0, nullptr, nullptr, nullptr, fileSystem, 64)
      || (_wcsicmp(fileSystem, L"NTFS") != 0 && _wcsicmp(fileSystem, L"ReFS") != 0))
    return fail("DATA_DIRECTORY_FILESYSTEM_UNSUPPORTED", GetLastError());

  // The directory handle also denies renaming/deleting the root while the
  // Gateway still addresses files under its canonical pathname.
  Handle dir(CreateFileW(directory.c_str(), FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE,
                         nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
  BY_HANDLE_FILE_INFORMATION dirInfo{};
  if (!dir.valid() || !GetFileInformationByHandle(dir.get(), &dirInfo)
      || !(dirInfo.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY)
      || (dirInfo.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT)) return fail("DATA_DIRECTORY_INVALID", GetLastError());
  const std::wstring file = directory + L"\\.cad-writer.lock";
  Handle lock(CreateFileW(file.c_str(), GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ,
                          nullptr, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
  if (!lock.valid()) {
    const DWORD error = GetLastError();
    return fail(error == ERROR_SHARING_VIOLATION || error == ERROR_LOCK_VIOLATION
      ? "DATA_DIRECTORY_IN_USE" : "DATA_DIRECTORY_LOCK_FAILED", error);
  }
  BY_HANDLE_FILE_INFORMATION lockInfo{};
  if (!GetFileInformationByHandle(lock.get(), &lockInfo) || lockInfo.nNumberOfLinks != 1
      || (lockInfo.dwFileAttributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DIRECTORY)))
    return fail("DATA_DIRECTORY_LOCK_INVALID", GetLastError());
  const std::wstring wideToken(argv[3]);
  const std::string token(wideToken.begin(), wideToken.end());
  std::ostringstream metadata;
  metadata << "{\"ok\":true,\"format\":\"web-cad-writer-lock\",\"version\":1,\"pid\":" << pid
           << ",\"processCreationFileTime\":\"" << timestamp(ownerStart) << "\",\"instanceId\":\"" << token
           << "\",\"mechanism\":\"windows-kernel-file-sharing\",\"directoryIdentity\":\""
           << std::hex << dirInfo.dwVolumeSerialNumber << ':' << dirInfo.nFileIndexHigh << ':' << dirInfo.nFileIndexLow << "\"}";
  const std::string text = metadata.str();
  LARGE_INTEGER beginning{}; DWORD written = 0;
  if (!SetFilePointerEx(lock.get(), beginning, nullptr, FILE_BEGIN) || !SetEndOfFile(lock.get())
      || !WriteFile(lock.get(), text.data(), static_cast<DWORD>(text.size()), &written, nullptr)
      || written != text.size() || !FlushFileBuffers(lock.get())) return fail("DATA_DIRECTORY_LOCK_FAILED", GetLastError());

  HANDLE remoteLock = nullptr, remoteDir = nullptr;
  if (!DuplicateHandle(GetCurrentProcess(), lock.get(), owner.get(), &remoteLock, 0, FALSE, DUPLICATE_SAME_ACCESS))
    return fail("DATA_DIRECTORY_LOCK_TRANSFER_FAILED", GetLastError());
  if (!DuplicateHandle(GetCurrentProcess(), dir.get(), owner.get(), &remoteDir, 0, FALSE, DUPLICATE_SAME_ACCESS)) {
    const DWORD error = GetLastError(); revoke(owner.get(), remoteLock);
    return fail("DATA_DIRECTORY_LOCK_TRANSFER_FAILED", error);
  }
  // The actual Node Gateway now owns non-inheritable handles. This bootstrap
  // helper exits; killing it can never release an active Gateway's lock.
  std::cout << text << std::endl;
  return 0;
}
