#pragma once
#include "protocol/Json.hxx"
#include <array>
#include <map>
#include <string>
#include <vector>

struct MeshQualityCell {
  std::size_t tag=0;
  int type=0,order=0,volumeTag=0;
  std::array<std::size_t,4> corners{};
  std::vector<std::string> bodyIds;
  double quality=0,minJacobian=0,maxJacobian=0;
  bool invalid=false,inverted=false,degenerate=false;
};
struct QualityReport {
  std::string qualityName;
  double threshold=.2;
  std::vector<double> positions;
  std::vector<MeshQualityCell> cells;
  std::size_t unsupportedCount=0;
};
QualityReport analyzeQuality(const occweb::JsonValue& parameters,const std::map<int,std::vector<std::string>>& owners={});
std::string qualityJson(const QualityReport& report);
void writeQualityIndex(const QualityReport& report,const std::string& outputPath,const std::string& requestId);
void verifyAsciiMeshElements(const std::string& inputPath);
