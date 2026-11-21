#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <filesystem>
#include <iostream>
#include <map>
#include <string>
#include <cwctype>

namespace fs=std::filesystem;
namespace {
std::wstring lower(std::wstring value){for(auto& c:value)c=static_cast<wchar_t>(std::towlower(c));return value;}
bool within(const fs::path& root,const fs::path& file){const auto a=lower(root.wstring()),b=lower(file.wstring());return b.size()>a.size()&&b.compare(0,a.size(),a)==0&&(b[a.size()]==L'\\'||b[a.size()]==L'/');}
bool ordinaryName(const std::wstring& name){
  if(name.empty()||name==L"."||name==L".."||name.back()==L'.'||name.back()==L' '||name.find_first_of(L"<>:\"|?*")!=std::wstring::npos)return false;
  for(const auto c:name)if(c<32)return false;
  auto stem=lower(name.substr(0,name.find(L'.')));
  return stem!=L"con"&&stem!=L"prn"&&stem!=L"aux"&&stem!=L"nul"&&!(stem.size()==4&&(stem.substr(0,3)==L"com"||stem.substr(0,3)==L"lpt")&&stem[3]>=L'0'&&stem[3]<=L'9');
}
std::wstring extended(const fs::path& file){auto value=file.wstring();if(value.rfind(L"\\\\?\\",0)==0)return value;if(value.rfind(L"\\\\",0)==0)return L"\\\\?\\UNC\\"+value.substr(2);return L"\\\\?\\"+value;}
bool realParents(const fs::path& root,const fs::path& file){
  if(!within(root,file))return false;
  fs::path current=root;const auto check=[](const fs::path& value){const DWORD attributes=GetFileAttributesW(extended(value).c_str());return attributes!=INVALID_FILE_ATTRIBUTES&&(attributes&FILE_ATTRIBUTE_DIRECTORY)&&!(attributes&FILE_ATTRIBUTE_REPARSE_POINT);};
  if(!check(root))return false;
  const auto relative=file.lexically_relative(root);
  for(auto it=relative.begin();it!=relative.end();++it){if(!ordinaryName(it->wstring()))return false;auto next=it;++next;if(next==relative.end())break;current/=*it;if(!check(current))return false;}
  return true;
}
bool regular(const fs::path& file){
  const auto handle=CreateFileW(extended(file).c_str(),FILE_READ_ATTRIBUTES,FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,nullptr,OPEN_EXISTING,FILE_FLAG_OPEN_REPARSE_POINT,nullptr);
  if(handle==INVALID_HANDLE_VALUE)return false;BY_HANDLE_FILE_INFORMATION info{};const bool ok=GetFileInformationByHandle(handle,&info)&&!(info.dwFileAttributes&(FILE_ATTRIBUTE_DIRECTORY|FILE_ATTRIBUTE_REPARSE_POINT))&&info.nNumberOfLinks==1;CloseHandle(handle);return ok;
}
bool absent(const fs::path& file){const DWORD attributes=GetFileAttributesW(extended(file).c_str());if(attributes!=INVALID_FILE_ATTRIBUTES)return false;const auto error=GetLastError();return error==ERROR_FILE_NOT_FOUND||error==ERROR_PATH_NOT_FOUND;}
void flush(const fs::path& file){const auto handle=CreateFileW(extended(file).c_str(),GENERIC_WRITE,FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,nullptr,OPEN_EXISTING,FILE_ATTRIBUTE_NORMAL,nullptr);if(handle!=INVALID_HANDLE_VALUE){FlushFileBuffers(handle);CloseHandle(handle);}}
}

int wmain(int argc,wchar_t** argv){
  try{
    std::map<std::wstring,std::wstring> args;
    for(int i=1;i<argc;i+=2){if(i+1>=argc||!args.emplace(argv[i],argv[i+1]).second)throw 1;}
    for(const auto& item:args)if(item.first!=L"--root"&&item.first!=L"--mode"&&item.first!=L"--target"&&item.first!=L"--stage"&&item.first!=L"--backup")throw 1;
    const auto normalize=[](const std::wstring& value){if(value.empty()||value.size()>8192)throw 1;const fs::path file(value);if(!file.is_absolute())throw 1;return file.lexically_normal();};
    const auto root=normalize(args.at(L"--root")),target=normalize(args.at(L"--target"));const auto mode=args.at(L"--mode");const auto privateRoot=root/L"source-restores";
    if(!within(root/L"imports",target)&&!within(root/L"project-assets",target))throw 1;
    if(!realParents(root,target)||(lower(target.extension().wstring())!=L".step"&&lower(target.extension().wstring())!=L".stp"))throw 1;
    const bool install=mode==L"install",replace=mode==L"replace",retire=mode==L"retire";if(!install&&!replace&&!retire)throw 1;
    fs::path stage,backup;if(!retire){stage=normalize(args.at(L"--stage"));if(!within(privateRoot,stage)||!realParents(root,stage)||!regular(stage))throw 1;}
    if(!install){backup=normalize(args.at(L"--backup"));if(!within(privateRoot,backup)||!realParents(root,backup)||!absent(backup)||!regular(target))throw 1;}
    else if(!absent(target))throw 1;
    if((retire&&args.count(L"--stage"))||(install&&args.count(L"--backup")))throw 1;
    BOOL result=FALSE;
    // ReplaceFile can leave renamed files on certain failures. The caller must
    // reconcile the durable journal against actual bytes; never blindly retry.
    if(install)result=MoveFileExW(extended(stage).c_str(),extended(target).c_str(),MOVEFILE_WRITE_THROUGH);
    else if(replace)result=ReplaceFileW(extended(target).c_str(),extended(stage).c_str(),extended(backup).c_str(),0,nullptr,nullptr);
    else result=MoveFileExW(extended(target).c_str(),extended(backup).c_str(),MOVEFILE_WRITE_THROUGH);
    const DWORD error=result?ERROR_SUCCESS:GetLastError();if(result){if(!retire)flush(target);if(!install)flush(backup);}
    std::cout<<"{\"ok\":"<<(result?"true":"false")<<",\"version\":1,\"winError\":"<<error<<"}\n";return result?0:2;
  }catch(...){std::cout<<"{\"ok\":false,\"version\":1,\"winError\":87}\n";return 2;}
}
