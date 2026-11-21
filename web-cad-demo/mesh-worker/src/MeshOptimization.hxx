#pragma once
#include "protocol/Json.hxx"
#include <map>
#include <string>
#include <vector>
namespace occweb {
// Empty when not requested. Does not change meshing/quality options globally.
std::string OptimizeMesh(const JsonValue& parameters,const std::map<int,std::vector<std::string>>& owners);
}
