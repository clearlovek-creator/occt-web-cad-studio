#include "../src/document/ShapeFingerprint.hxx"
#include "../src/document/TopologyNaming.hxx"
#include "../src/exchange/StepImport.hxx"
#include "../src/presentation/ShapeSerializer.hxx"
#include "../src/protocol/Json.hxx"
#include <BRepTools.hxx>
#include <BRep_Builder.hxx>
#include <BRepBuilderAPI_Copy.hxx>
#include <BRepBuilderAPI_MakeFace.hxx>
#include <BRepPrimAPI_MakeBox.hxx>
#include <BRepPrimAPI_MakeCylinder.hxx>
#include <BRepMesh_IncrementalMesh.hxx>
#include <Geom_BSplineSurface.hxx>
#include <NCollection_Array1.hxx>
#include <NCollection_Array2.hxx>
#include <NCollection_IndexedMap.hxx>
#include <TopExp.hxx>
#include <TopoDS_Compound.hxx>
#include <TopTools_ShapeMapHasher.hxx>
#include <STEPControl_Writer.hxx>
#include <IFSelect_ReturnStatus.hxx>
#include <chrono>
#include <cmath>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <locale>
#include <sstream>
#include <stdexcept>
#include <atomic>
#include <thread>
#ifdef _WIN32
#include <windows.h>
#include <psapi.h>
#else
#include <sys/resource.h>
#endif

using namespace occweb;
namespace {
using Clock=std::chrono::steady_clock;
void require(bool value,const std::string& message){if(!value)throw std::runtime_error(message);}
double elapsed(Clock::time_point start){return std::chrono::duration<double,std::milli>(Clock::now()-start).count();}
struct MemorySample {std::size_t Rss=0,Private=0;};
MemorySample memorySample(){
#ifdef _WIN32
  PROCESS_MEMORY_COUNTERS_EX counters{};require(GetProcessMemoryInfo(GetCurrentProcess(),reinterpret_cast<PROCESS_MEMORY_COUNTERS*>(&counters),sizeof(counters))!=0,"Cannot observe process memory");return {counters.WorkingSetSize,counters.PrivateUsage};
#else
  return {};
#endif
}
struct MemoryProbe {
  MemorySample Before=memorySample(),Peak=Before;std::atomic<bool> Running{true};
  std::thread Thread{[this]{while(Running.load()){const auto sample=memorySample();Peak.Rss=std::max(Peak.Rss,sample.Rss);Peak.Private=std::max(Peak.Private,sample.Private);std::this_thread::sleep_for(std::chrono::milliseconds(1));}}};
  void Stop(){Running=false;if(Thread.joinable())Thread.join();const auto sample=memorySample();Peak.Rss=std::max(Peak.Rss,sample.Rss);Peak.Private=std::max(Peak.Private,sample.Private);}
  ~MemoryProbe(){Stop();}
};
std::size_t peakRss(){
#ifdef _WIN32
  PROCESS_MEMORY_COUNTERS counters{};require(GetProcessMemoryInfo(GetCurrentProcess(),&counters,sizeof(counters))!=0,"Cannot observe process peak working set");return counters.PeakWorkingSetSize;
#else
  rusage usage{};require(getrusage(RUSAGE_SELF,&usage)==0,"Cannot observe process peak RSS");
#ifdef __APPLE__
  return static_cast<std::size_t>(usage.ru_maxrss);
#else
  return static_cast<std::size_t>(usage.ru_maxrss)*1024u;
#endif
#endif
}
// Deliberate independent copy of the pre-streaming BRep serialization path.
// Kept in a test executable only; never selected by the production worker.
std::string legacyFingerprint(const TopoDS_Shape& shape,std::size_t* bytes=nullptr){
  std::ostringstream geometry;geometry.imbue(std::locale::classic());
  BRepBuilderAPI_Copy copy(shape,false,false);const auto normalized=copy.Shape();
  NCollection_IndexedMap<TopoDS_Shape,TopTools_ShapeMapHasher> subshapes;TopExp::MapShapes(normalized,subshapes);
  for(int i=1;i<=subshapes.Extent();++i){auto subshape=subshapes(i);subshape.Free(false);subshape.Modified(false);subshape.Checked(false);}
  BRepTools::Write(normalized,geometry,false,false,TopTools_FormatVersion_VERSION_3);
  if(bytes)*bytes=static_cast<std::size_t>(geometry.tellp());
  return StableDigest(geometry.str());
}
TopoDS_Shape patches(int count,int size){
  TopoDS_Compound result;BRep_Builder builder;builder.MakeCompound(result);
  for(int patch=0;patch<count;++patch){
    NCollection_Array2<gp_Pnt> poles(1,size,1,size);
    for(int u=1;u<=size;++u)for(int v=1;v<=size;++v){
      const double x=double(u-1)/(size-1),y=double(v-1)/(size-1);
      poles.SetValue(u,v,gp_Pnt((patch%16)*12+10*x,(patch/16)*12+10*y,std::sin(3*x+0.01*patch)*std::cos(2*y)+0.002*patch));
    }
    const int knotsCount=size-2;NCollection_Array1<double> knots(1,knotsCount);NCollection_Array1<int> multiplicities(1,knotsCount);
    for(int i=1;i<=knotsCount;++i){knots.SetValue(i,double(i-1)/(knotsCount-1));multiplicities.SetValue(i,i==1||i==knotsCount?4:1);}
    Handle(Geom_BSplineSurface) surface=new Geom_BSplineSurface(poles,knots,knots,multiplicities,multiplicities,3,3);
    const auto face=BRepBuilderAPI_MakeFace(surface,1e-7).Face();builder.Add(result,face);
  }
  return result;
}
void selfTest(){
  require(StableDigest("")=="e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855","Empty SHA256 changed");
  require(StableDigest("abc")=="ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad","SHA256 abc changed");
  require(StableDigest(std::string(1000000,'a'))=="cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0","Multi-block SHA256 changed");
  bool multipleBlocks=false;
  for(const auto& shape:{BRepPrimAPI_MakeBox(10,20,30).Shape(),BRepPrimAPI_MakeCylinder(5,20).Shape(),patches(3,32)}){
    std::size_t bytes=0;const auto expected=legacyFingerprint(shape,&bytes);ShapeFingerprintStats stats;
    require(ShapeFingerprint(shape,&stats)==expected,"Fingerprint differs from exact legacy BRep bytes");
    require(stats.SerializedBytes==bytes&&stats.PeakBufferedBytes<=64u*1024u,"Streaming evidence byte count or bounded buffer differs");multipleBlocks=multipleBlocks||bytes>64u*1024u;
    BRepMesh_IncrementalMesh mesh(shape,0.3);require(mesh.IsDone(),"Meshing fixture failed");require(ShapeFingerprint(shape)==expected,"Transient triangulation altered exact fingerprint");
  }
  require(multipleBlocks,"Native parity fixture did not cross a streaming block boundary");
  std::cout<<"PASS SHA256 known vectors and exact legacy BRep parity before/after triangulation\n";
  std::cout<<"PASS multi-block BRep evidence is complete with at most 64 KiB buffered payload\n";
}
}
int main(){try{
  std::string input;if(!std::getline(std::cin,input)||input.empty()){selfTest();return 0;}
  const auto request=JsonParser(input).Parse();const auto mode=request.GetString("mode");
  if(mode!="prepare"&&mode!="legacy"&&mode!="current")throw std::runtime_error("Unsupported fingerprint benchmark mode");
  const auto directory=std::filesystem::absolute(std::filesystem::u8path(request.GetString("directory"))).lexically_normal();
  const auto file=directory/"surfaces.step";auto result=JsonValue::MakeObject();result.ChangeObject()["mode"]=JsonValue(mode);
  if(mode=="prepare"){
    const int count=request.GetInteger("patches"),size=request.GetInteger("poles");require(count>=1&&count<=256&&size>=4&&size<=128&&count*size*size<=1048576,"Benchmark fixture exceeds bounds");
    require(!std::filesystem::exists(file),"Do not overwrite a benchmark fixture");std::filesystem::create_directories(directory);
    const auto start=Clock::now();const auto shape=patches(count,size);STEPControl_Writer writer;
    require(writer.Transfer(shape,STEPControl_AsIs)==IFSelect_RetDone,"STEP transfer failed");require(writer.Write(file.u8string().c_str())==IFSelect_RetDone,"STEP write failed");
    result.ChangeObject()["prepareMs"]=JsonValue(elapsed(start));result.ChangeObject()["stepBytes"]=JsonValue(double(std::filesystem::file_size(file)));
  }else{
    require(std::filesystem::is_regular_file(file),"STEP benchmark fixture is missing");
    const auto importStart=Clock::now();const auto imported=ReadStepParts(file.u8string(),2);result.ChangeObject()["importMs"]=JsonValue(elapsed(importStart));
    result.ChangeObject()["sourceFingerprint"]=JsonValue(imported.SourceFingerprint);result.ChangeObject()["parts"]=JsonValue(double(imported.Parts.size()));
    result.ChangeObject()["peakRssBeforeHash"]=JsonValue(double(peakRss()));
    auto hashes=JsonValue::MakeArray();std::size_t serializedBytes=0,peakBuffer=0,faceCount=0,edgeCount=0;MemoryProbe memory;const auto start=Clock::now();
    for(const auto& part:imported.Parts){ShapeSerializer topology(part.Shape,0,"");faceCount+=topology.Faces().Extent();edgeCount+=topology.Edges().Extent();
      std::size_t bytes=0;ShapeFingerprintStats stats;hashes.ChangeArray().emplace_back(mode=="legacy"?legacyFingerprint(part.Shape,&bytes):ShapeFingerprint(part.Shape,&stats));serializedBytes+=mode=="legacy"?bytes:stats.SerializedBytes;peakBuffer=std::max(peakBuffer,mode=="legacy"?bytes:stats.PeakBufferedBytes);
    }
    result.ChangeObject()["hashMs"]=JsonValue(elapsed(start));memory.Stop();result.ChangeObject()["hashes"]=std::move(hashes);result.ChangeObject()["serializedBytes"]=JsonValue(double(serializedBytes));result.ChangeObject()["peakBufferedPayloadBytes"]=JsonValue(double(peakBuffer));
    result.ChangeObject()["hashPrivateBefore"]=JsonValue(double(memory.Before.Private));result.ChangeObject()["hashPrivatePeak"]=JsonValue(double(memory.Peak.Private));result.ChangeObject()["hashRssBefore"]=JsonValue(double(memory.Before.Rss));result.ChangeObject()["hashRssPeak"]=JsonValue(double(memory.Peak.Rss));
    result.ChangeObject()["faces"]=JsonValue(double(faceCount));result.ChangeObject()["edges"]=JsonValue(double(edgeCount));
  }
  result.ChangeObject()["peakRss"]=JsonValue(double(peakRss()));std::cout<<"FINGERPRINT_BENCH "<<JsonSerialize(result)<<'\n';return 0;
}catch(const std::exception& error){std::cerr<<error.what()<<'\n';return 1;}}
