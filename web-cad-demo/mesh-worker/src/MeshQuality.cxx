#include "MeshQuality.hxx"
#include <gmsh.h>
#include <algorithm>
#include <cmath>
#include <fstream>
#include <filesystem>
#include <iomanip>
#include <limits>
#include <set>
#include <sstream>
#include <stdexcept>
#include <unordered_map>

namespace {
using occweb::JsonEscape;
void number(std::ostream& out,double value) {if(std::isfinite(value))out<<value;else out<<"null";}
struct Statistics {
  std::size_t count=0,finite=0,bad=0,invalid=0,inverted=0,degenerate=0;
  double minimum=std::numeric_limits<double>::infinity(),maximum=-std::numeric_limits<double>::infinity(),sum=0,compensation=0;
  void add(const MeshQualityCell& cell,double threshold) {
    ++count;if(cell.invalid)++invalid;if(cell.inverted)++inverted;if(cell.degenerate)++degenerate;
    if(cell.invalid||cell.inverted||cell.degenerate||cell.quality<threshold)++bad;
    if(!std::isfinite(cell.quality))return;
    ++finite;minimum=std::min(minimum,cell.quality);maximum=std::max(maximum,cell.quality);const double next=sum+cell.quality;compensation+=std::abs(sum)>=std::abs(cell.quality)?(sum-next)+cell.quality:(cell.quality-next)+sum;sum=next;
  }
};
void statisticsJson(std::ostream& out,const Statistics& s) {
  out<<"\"tetraCount\":"<<s.count<<",\"finiteCount\":"<<s.finite<<",\"nonFiniteQualityCount\":"<<s.count-s.finite
    <<",\"badCount\":"<<s.bad<<",\"invalidCount\":"<<s.invalid<<",\"invertedCount\":"<<s.inverted<<",\"degenerateCount\":"<<s.degenerate<<",\"minQuality\":";
  number(out,s.minimum);out<<",\"maxQuality\":";number(out,s.maximum);out<<",\"averageQuality\":";number(out,s.finite?(s.sum+s.compensation)/static_cast<double>(s.finite):std::numeric_limits<double>::quiet_NaN());
}
}

QualityReport analyzeQuality(const occweb::JsonValue& parameters,const std::map<int,std::vector<std::string>>& owners) {
  QualityReport report;report.qualityName=parameters.GetStringOr("qualityName","minSICN");report.threshold=parameters.GetNumberOr("qualityThreshold",.2);
  if(!std::isfinite(report.threshold)||(report.qualityName=="minSICN"&&(report.threshold<0||report.threshold>1)))throw std::runtime_error("Invalid quality threshold for the requested measure.");
  std::vector<std::size_t> nodeTags;std::vector<double> parametric;
  gmsh::model::mesh::getNodes(nodeTags,report.positions,parametric);
  if(report.positions.size()!=nodeTags.size()*3)throw std::runtime_error("Invalid mesh node coordinate table.");
  std::unordered_map<std::size_t,std::size_t> indices;
  for(std::size_t i=0;i<nodeTags.size();++i)indices.emplace(nodeTags[i],i);
  gmsh::vectorpair entities;gmsh::model::getEntities(entities,3);std::sort(entities.begin(),entities.end());
  std::set<std::size_t> seen;
  for(const auto& entity:entities) {
    std::vector<int> types;std::vector<std::vector<std::size_t>> tags,nodes;
    gmsh::model::mesh::getElements(types,tags,nodes,3,entity.second);
    for(std::size_t block=0;block<types.size();++block) {
      std::string name;int dimension,order,numNodes,primary;std::vector<double> local;
      gmsh::model::mesh::getElementProperties(types[block],name,dimension,order,numNodes,local,primary);
      if(dimension!=3||primary!=4||name.rfind("Tetrahedron",0)!=0){report.unsupportedCount+=tags[block].size();continue;}
      if(numNodes<4||nodes[block].size()!=tags[block].size()*static_cast<std::size_t>(numNodes))throw std::runtime_error("Invalid tetrahedral connectivity table.");
      std::vector<double> qualities,minima,maxima;
      gmsh::model::mesh::getElementQualities(tags[block],qualities,report.qualityName);
      gmsh::model::mesh::getElementQualities(tags[block],minima,"minDetJac");
      gmsh::model::mesh::getElementQualities(tags[block],maxima,"maxDetJac");
      if(qualities.size()!=tags[block].size()||minima.size()!=qualities.size()||maxima.size()!=qualities.size())throw std::runtime_error("Incomplete tetrahedral quality results.");
      for(std::size_t i=0;i<tags[block].size();++i) {
        if(!seen.insert(tags[block][i]).second)throw std::runtime_error("Duplicate tetrahedral element identity.");
        MeshQualityCell cell;cell.tag=tags[block][i];cell.type=types[block];cell.order=order;cell.volumeTag=entity.second;
        cell.quality=qualities[i];cell.minJacobian=minima[i];cell.maxJacobian=maxima[i];
        if(report.qualityName=="minSICN"&&std::isfinite(cell.quality)) {
          if(cell.quality>1&&cell.quality<=1+1e-12)cell.quality=1;
          if(cell.quality< -1&&cell.quality>=-1-1e-12)cell.quality=-1;
        }
        if(const auto found=owners.find(entity.second);found!=owners.end())cell.bodyIds=found->second;
        std::sort(cell.bodyIds.begin(),cell.bodyIds.end());cell.bodyIds.erase(std::unique(cell.bodyIds.begin(),cell.bodyIds.end()),cell.bodyIds.end());
        cell.invalid=!std::isfinite(cell.quality)||!std::isfinite(cell.minJacobian)||!std::isfinite(cell.maxJacobian)
          ||(report.qualityName=="minSICN"&&(cell.quality< -1||cell.quality>1));
        cell.inverted=std::isfinite(cell.minJacobian)&&cell.minJacobian<0;
        cell.degenerate=!cell.inverted&&std::isfinite(cell.minJacobian)&&std::isfinite(cell.maxJacobian)
          &&(cell.maxJacobian==0||cell.minJacobian<=std::abs(cell.maxJacobian)*1e-12);
        for(std::size_t corner=0;corner<4;++corner) {
          const auto found=indices.find(nodes[block][i*numNodes+corner]);
          if(found==indices.end())throw std::runtime_error("A tetrahedral corner refers to a missing node.");
          cell.corners[corner]=found->second;
          for(int axis=0;axis<3;++axis)if(!std::isfinite(report.positions[found->second*3+axis]))cell.invalid=true;
        }
        report.cells.push_back(std::move(cell));
      }
    }
  }
  return report;
}

std::string qualityJson(const QualityReport& report) {
  Statistics all;std::map<std::string,Statistics> perBody;
  for(const auto& cell:report.cells){all.add(cell,report.threshold);for(const auto& body:cell.bodyIds)perBody[body].add(cell,report.threshold);}
  std::ostringstream out;out<<std::setprecision(17)<<"\"version\":2,\"summation\":\"neumaier-v1\",\"qualityName\":\""<<JsonEscape(report.qualityName)<<"\",\"threshold\":"<<report.threshold
    <<",\"orientationBasis\":\"adaptive-minDetJac\",\"unsupportedElementCount\":"<<report.unsupportedCount<<",\"status\":\""<<(report.unsupportedCount?"partial":all.count==0?"not-applicable":"complete")<<"\",";
  statisticsJson(out,all);
  std::size_t outside=0;if(report.qualityName=="minSICN")for(const auto& c:report.cells)if(std::isfinite(c.quality)&&(c.quality< -1||c.quality>1))++outside;
  out<<",\"outOfRangeCount\":"<<outside<<",\"histogram\":[";
  const bool normalized=report.qualityName=="minSICN";const int bins=normalized?11:10;
  const double lower=all.finite?all.minimum:0,upper=all.finite&&all.maximum>lower?all.maximum:lower+1;
  for(int i=0;i<bins;++i){const double lo=normalized?(i==0?-1.:(i-1)/10.):lower+(upper-lower)*i/bins;
    const double hi=normalized?(i==0?0.:i/10.):lower+(upper-lower)*(i+1)/bins;
    std::size_t count=0;for(const auto& c:report.cells)if(std::isfinite(c.quality)&&c.quality>=lo&&(i==bins-1?c.quality<=hi:c.quality<hi))++count;
    if(i)out<<',';out<<"{\"lower\":"<<lo<<",\"upper\":"<<hi<<",\"includeUpper\":"<<(i==bins-1?"true":"false")<<",\"count\":"<<count<<'}';}
  out<<"],\"perBody\":[";bool first=true;
  for(const auto& [body,stats]:perBody){if(!first)out<<',';first=false;out<<"{\"bodyId\":\""<<JsonEscape(body)<<"\",";statisticsJson(out,stats);out<<'}';}
  out<<']';return out.str();
}

void writeQualityIndex(const QualityReport& report,const std::string& outputPath,const std::string& requestId) {
  if(outputPath.empty())return;
  std::ofstream out(std::filesystem::path(outputPath),std::ios::binary|std::ios::trunc);if(!out)throw std::runtime_error("Cannot write the mesh quality index.");
  out<<std::setprecision(17)<<"{\"version\":1,\"requestId\":\""<<JsonEscape(requestId)<<"\",\"qualityName\":\""<<JsonEscape(report.qualityName)<<"\",\"threshold\":"<<report.threshold<<",\"positions\":[";
  for(std::size_t i=0;i<report.positions.size();++i){if(i)out<<',';number(out,report.positions[i]);}
  out<<"],\"cells\":[";
  for(std::size_t i=0;i<report.cells.size();++i){const auto& c=report.cells[i];if(i)out<<',';
    out<<"{\"elementId\":\""<<c.tag<<"\",\"elementType\":"<<c.type<<",\"order\":"<<c.order<<",\"volumeTag\":"<<c.volumeTag<<",\"quality\":";number(out,c.quality);
    out<<",\"minJacobian\":";number(out,c.minJacobian);out<<",\"maxJacobian\":";number(out,c.maxJacobian);
    out<<",\"invalid\":"<<(c.invalid?"true":"false")<<",\"inverted\":"<<(c.inverted?"true":"false")<<",\"degenerate\":"<<(c.degenerate?"true":"false")<<",\"corners\":[";
    for(std::size_t n=0;n<4;++n){if(n)out<<',';out<<c.corners[n];}out<<"],\"bodyIds\":[";
    for(std::size_t n=0;n<c.bodyIds.size();++n){if(n)out<<',';out<<'"'<<JsonEscape(c.bodyIds[n])<<'"';}out<<"]}";
  }
  out<<"]}";out.flush();if(!out)throw std::runtime_error("Mesh quality index write failed.");
}

void verifyAsciiMeshElements(const std::string& inputPath) {
  std::ifstream in{std::filesystem::path(inputPath)};if(!in)throw std::runtime_error("Cannot read the mesh input for element identity verification.");std::string line;double version=0;bool ascii=false;
  while(std::getline(in,line)) {
    if(!line.empty()&&line.back()=='\r')line.pop_back();
    if(line=="$MeshFormat") {int binary=1,width;in>>version>>binary>>width;ascii=binary==0;if(!ascii)return;}
    if(line!="$Elements"||!ascii)continue;
    std::size_t declared=0,blocks=0,minimum=0,maximum=0;
    if(version<4)in>>declared;else in>>blocks>>declared>>minimum>>maximum;
    std::vector<int> types;std::vector<std::vector<std::size_t>> tags,nodes;gmsh::model::mesh::getElements(types,tags,nodes);
    std::set<std::size_t> actual;for(const auto& list:tags)actual.insert(list.begin(),list.end());
    if(actual.size()!=declared)throw std::runtime_error("Gmsh did not preserve all elements from this ASCII MSH input; quality analysis was not published.");
    if(version>=4&&!actual.empty()&&(*actual.begin()!=minimum||*actual.rbegin()!=maximum))throw std::runtime_error("Gmsh did not preserve the element identity range from this MSH input.");
    if(version<4) {
      std::getline(in,line);
      for(std::size_t i=0;i<declared;++i) {
        if(!std::getline(in,line))throw std::runtime_error("Incomplete ASCII MSH element table.");
        std::istringstream row(line);std::size_t tag;
        if(!(row>>tag)||!actual.count(tag))throw std::runtime_error("Gmsh did not preserve element identities from this legacy MSH input.");
      }
    }
    return;
  }
}
