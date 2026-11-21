// SPDX-License-Identifier: GPL-3.0-or-later
// Diagnostic link-only probe. Never linked into a product release.
#include <windows.h>
#include <dbghelp.h>

namespace {
volatile LONG captured=0;
LONG CALLBACK capture(EXCEPTION_POINTERS* pointers) {
  if(pointers->ExceptionRecord->ExceptionCode!=EXCEPTION_ACCESS_VIOLATION ||
     InterlockedCompareExchange(&captured,1,0)!=0)return EXCEPTION_CONTINUE_SEARCH;
  const HANDLE file=CreateFileW(L"fault.dmp",GENERIC_WRITE,0,nullptr,CREATE_NEW,FILE_ATTRIBUTE_NORMAL,nullptr);
  if(file!=INVALID_HANDLE_VALUE){
    MINIDUMP_EXCEPTION_INFORMATION info{GetCurrentThreadId(),pointers,FALSE};
    MiniDumpWriteDump(GetCurrentProcess(),GetCurrentProcessId(),file,MiniDumpNormal,&info,nullptr,nullptr);
    CloseHandle(file);
  }
  return EXCEPTION_CONTINUE_SEARCH;
}
struct Install {
  Install(){SetErrorMode(SEM_FAILCRITICALERRORS|SEM_NOGPFAULTERRORBOX);AddVectoredExceptionHandler(1,capture);}
} install;
}
