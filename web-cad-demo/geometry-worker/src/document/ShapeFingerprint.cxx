#include "ShapeFingerprint.hxx"
#include "CadError.hxx"
#include <BRepTools.hxx>
#include <BRepBuilderAPI_Copy.hxx>
#include <TopExp.hxx>
#include <NCollection_IndexedMap.hxx>
#include <iomanip>
#include <locale>
#include <sstream>
#include <vector>
#include <algorithm>
#include <array>
#include <cstring>
#include <limits>
#include <memory>
#include <streambuf>
#ifdef _WIN32
#include <windows.h>
#include <bcrypt.h>
#else
#include <openssl/evp.h>
#endif

namespace occweb
{
namespace {
class Sha256Accumulator {
#ifdef _WIN32
  struct Handles
  {
    BCRYPT_ALG_HANDLE Algorithm = nullptr;
    BCRYPT_HASH_HANDLE Hash = nullptr;
    std::vector<unsigned char> Object;
    ~Handles() { if (Hash) BCryptDestroyHash(Hash); if (Algorithm) BCryptCloseAlgorithmProvider(Algorithm, 0); }
  } myHandles;
  static void check(NTSTATUS status)
  {
    if (status < 0) throw CadError("FINGERPRINT_FAILED", "Could not compute the BRep selection fingerprint.");
  }
#else
  std::unique_ptr<EVP_MD_CTX,decltype(&EVP_MD_CTX_free)> myContext{EVP_MD_CTX_new(),EVP_MD_CTX_free};
  static void check(int status){if(status!=1)throw CadError("FINGERPRINT_FAILED","Could not compute the BRep selection fingerprint.");}
#endif
  bool myFinished=false;
public:
  Sha256Accumulator(){
#ifdef _WIN32
  check(BCryptOpenAlgorithmProvider(&myHandles.Algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0));
  DWORD objectSize = 0, received = 0;
  check(BCryptGetProperty(myHandles.Algorithm, BCRYPT_OBJECT_LENGTH,
                         reinterpret_cast<PUCHAR>(&objectSize), sizeof(objectSize), &received, 0));
  myHandles.Object.resize(objectSize);
  check(BCryptCreateHash(myHandles.Algorithm, &myHandles.Hash, myHandles.Object.data(), objectSize, nullptr, 0, 0));
#else
  if(!myContext)throw CadError("FINGERPRINT_FAILED","Could not allocate the BRep digest context.");
  check(EVP_DigestInit_ex(myContext.get(),EVP_sha256(),nullptr));
#endif
  }
  Sha256Accumulator(const Sha256Accumulator&)=delete;
  Sha256Accumulator& operator=(const Sha256Accumulator&)=delete;
  void Update(const char* bytes,std::size_t size){
    if(myFinished)throw CadError("FINGERPRINT_FAILED","Cannot append to a finalized BRep digest.");
#ifdef _WIN32
  for (std::size_t offset = 0; offset < size;)
  {
    const ULONG count = static_cast<ULONG>(std::min<std::size_t>(size - offset, 1u << 30));
    check(BCryptHashData(myHandles.Hash, reinterpret_cast<PUCHAR>(const_cast<char*>(bytes + offset)), count, 0));
    offset += count;
  }
#else
  if(size)check(EVP_DigestUpdate(myContext.get(),bytes,size));
#endif
  }
  std::string Finish(){
    if(myFinished)throw CadError("FINGERPRINT_FAILED","BRep digest was already finalized.");
    unsigned char digest[32]{};
#ifdef _WIN32
    check(BCryptFinishHash(myHandles.Hash,digest,sizeof(digest),0));
#else
    unsigned int length=0;check(EVP_DigestFinal_ex(myContext.get(),digest,&length));
    if(length!=sizeof(digest))throw CadError("FINGERPRINT_FAILED","BRep digest has an unexpected length.");
#endif
    myFinished=true;
  std::ostringstream out;
  out << std::hex << std::setfill('0');
  for (unsigned char value : digest) out << std::setw(2) << static_cast<unsigned int>(value);
  return out.str();
  }
};

class DigestStreamBuffer final:public std::streambuf {
  std::array<char,64u*1024u> myBuffer{};
  Sha256Accumulator& myDigest;
  ShapeFingerprintStats myStats;
  void Flush(){
    const auto count=static_cast<std::size_t>(pptr()-pbase());
    if(!count)return;
    if(myStats.SerializedBytes>std::numeric_limits<std::size_t>::max()-count)throw CadError("FINGERPRINT_FAILED","BRep evidence length overflowed.");
    myDigest.Update(pbase(),count);myStats.SerializedBytes+=count;
    myStats.PeakBufferedBytes=std::max(myStats.PeakBufferedBytes,count);setp(myBuffer.data(),myBuffer.data()+myBuffer.size());
  }
protected:
  int_type overflow(int_type value)override{
    Flush();if(!traits_type::eq_int_type(value,traits_type::eof())){*pptr()=traits_type::to_char_type(value);pbump(1);}
    return traits_type::not_eof(value);
  }
  std::streamsize xsputn(const char* bytes,std::streamsize size)override{
    if(size<=0)return 0;
    std::streamsize offset=0;
    while(offset<size){
      if(pptr()==epptr())Flush();
      const auto count=std::min<std::streamsize>(epptr()-pptr(),size-offset);
      std::memcpy(pptr(),bytes+offset,static_cast<std::size_t>(count));pbump(static_cast<int>(count));offset+=count;
    }
    return size;
  }
  int sync()override{Flush();return 0;}
public:
  explicit DigestStreamBuffer(Sha256Accumulator& digest):myDigest(digest){setp(myBuffer.data(),myBuffer.data()+myBuffer.size());}
  const ShapeFingerprintStats& Stats()const{return myStats;}
};
}

std::string ShapeFingerprint(const TopoDS_Shape& shape,ShapeFingerprintStats* stats)
{
  if(stats)*stats={};
  Sha256Accumulator digest;DigestStreamBuffer buffer(digest);std::ostream geometry(&buffer);
  geometry.imbue(std::locale::classic());geometry.exceptions(std::ios::badbit|std::ios::failbit);
  // Same topology copy, normalized flags, locale and BRep v3 bytes as legacy
  // evidence. Only the sink changes: no whole serialized BRep or str() copy.
  BRepBuilderAPI_Copy copy(shape,false,false);const auto normalized=copy.Shape();
  NCollection_IndexedMap<TopoDS_Shape,TopTools_ShapeMapHasher> subshapes;TopExp::MapShapes(normalized,subshapes);
  for(int i=1;i<=subshapes.Extent();++i){auto subshape=subshapes(i);subshape.Free(false);subshape.Modified(false);subshape.Checked(false);}
  BRepTools::Write(normalized,geometry,false,false,TopTools_FormatVersion_VERSION_3);geometry.flush();
  const auto result=digest.Finish();if(stats)*stats=buffer.Stats();return result;
}

std::string StableDigest(const std::string& bytes)
{
  Sha256Accumulator digest;digest.Update(bytes.data(),bytes.size());return digest.Finish();
}
}
