#include "MeshQuality.hxx"
#include <iostream>
#include <stdexcept>
int main(){
  try{
    QualityReport report;report.qualityName="minSICN";report.cells.resize(1000000);
    for(auto& cell:report.cells){cell.quality=.8;cell.minJacobian=1;cell.maxJacobian=1;}
    const auto text="{"+qualityJson(report)+"}";const auto value=occweb::JsonParser(text).Parse();
    if(value.GetString("summation")!="neumaier-v1"||value.GetNumber("averageQuality")!=.8||value.GetNumber("tetraCount")!=1000000)throw std::runtime_error("Million-cell decimal quality average drifted");
    std::cout<<"Native million-cell compensated quality statistics passed"<<std::endl;return 0;
  }catch(const std::exception& error){std::cerr<<error.what()<<std::endl;return 1;}
}
