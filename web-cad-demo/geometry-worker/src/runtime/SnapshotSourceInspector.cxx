#include "../exchange/SnapshotSources.hxx"
#include "../protocol/Json.hxx"
#include <Standard_Failure.hxx>
#include <iostream>
#include <string>
int main(){
  try{
    std::string line;char value;while(std::cin.get(value)&&value!='\n'){if(line.size()>=32768)throw std::runtime_error("Inspection request exceeds its size limit.");line.push_back(value);}
    const auto request=occweb::JsonParser(line).Parse();const auto file=request.GetString("path");
    if(file.empty()||file.size()>8192)throw std::runtime_error("Invalid checkpoint path.");
    std::cout<<occweb::InspectSnapshotSources(file)<<std::endl;return 0;
  }catch(const Standard_Failure&){std::cout<<"{\"ok\":false,\"code\":\"SOURCE_SNAPSHOT_UNREADABLE\",\"error\":\"OCCT could not inspect checkpoint metadata.\"}"<<std::endl;}
  catch(const std::exception&){std::cout<<"{\"ok\":false,\"code\":\"SOURCE_SNAPSHOT_UNREADABLE\",\"error\":\"Checkpoint source metadata could not be verified.\"}"<<std::endl;}
  return 1;
}
