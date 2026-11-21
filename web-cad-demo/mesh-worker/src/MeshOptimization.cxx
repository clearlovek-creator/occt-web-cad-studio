#include "MeshOptimization.hxx"
#include "MeshQuality.hxx"
#include <gmsh.h>
#include <set>
#include <stdexcept>
namespace occweb {
std::string OptimizeMesh(const JsonValue& parameters,const std::map<int,std::vector<std::string>>& owners){
  const auto* input=parameters.Find("optimization");if(!input)return {};
  if(!input->IsObject())throw std::runtime_error("Mesh optimization must be an explicit object.");
  const std::set<std::string> allowed={"version","method","iterations"};for(const auto& [key,value]:input->AsObject())if(!allowed.count(key))throw std::runtime_error("Unknown mesh optimization setting.");
  if(input->GetInteger("version")!=1||input->GetString("method")!="netgen")throw std::runtime_error("Unsupported mesh optimization method or version.");
  const int iterations=input->GetInteger("iterations");if(iterations<1||iterations>5)throw std::runtime_error("Mesh optimization iterations must be between 1 and 5.");
  const auto summarize=[&](){const auto report=analyzeQuality(parameters,owners);if(report.cells.empty()||report.unsupportedCount)throw std::runtime_error("Netgen optimization requires a complete tetrahedral volume mesh.");return "{"+qualityJson(report)+"}";};
  const auto before=summarize();gmsh::model::mesh::optimize("Netgen",false,iterations);const auto after=summarize();
  return "{\"version\":1,\"method\":\"netgen\",\"iterations\":"+std::to_string(iterations)+",\"before\":"+before+",\"after\":"+after+"}";
}
}
