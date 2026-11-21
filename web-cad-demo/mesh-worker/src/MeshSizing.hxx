#pragma once
#include "protocol/Json.hxx"
#include "MeshProvenance.hxx"
#include <stdexcept>
#include <string>
#include <vector>
#include <utility>
namespace occweb {
class MeshSizingError:public std::runtime_error {public:MeshSizingError(std::string code,const std::string& message):std::runtime_error(message),Code(std::move(code)){}std::string Code;};
class MeshSizingScope {
public:
  MeshSizingScope(const JsonValue& parameters,const PreparedMeshMapping* mapping);
  ~MeshSizingScope();
  MeshSizingScope(const MeshSizingScope&)=delete;MeshSizingScope& operator=(const MeshSizingScope&)=delete;
  const std::string& Report()const{return myReport;}
private:
  std::vector<std::pair<std::string,double>> myOptions;
  std::vector<int> myFields;
  std::string myReport;
  void restore() noexcept;
};
}
