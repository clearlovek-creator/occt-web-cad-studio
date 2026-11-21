#pragma once

#include "../protocol/Json.hxx"

#include <array>
#include <map>
#include <string>

namespace occweb
{
enum class ScalarDimension { Length, Angle, Dimensionless, Integer };

inline std::string ScalarParameterType(const std::string& key)
{
  if (key == "angleDegrees") return "angle";
  if (key == "sides" || key == "count" || key == "countX" || key == "countY") return "integer";
  if (key == "factor" || key == "factorX" || key == "factorY" || key == "factorZ"
      || key.rfind("axis", 0) == 0 || key.rfind("normal", 0) == 0
      || key.rfind("neutralNormal", 0) == 0 || key.rfind("direction", 0) == 0) return "dimensionless";
  return "length";
}

struct EvaluatedScalar
{
  double Value = 0.0;
  ScalarDimension Dimension = ScalarDimension::Dimensionless;
};

struct ScalarVariable
{
  std::string Name;
  ScalarDimension Dimension = ScalarDimension::Dimensionless;
  std::string Expression;
  double Value = 0.0;
};

class ScalarVariableStore
{
public:
  void Clear();
  void Set(const std::string& name, const std::string& type, const std::string& expression);
  void Delete(const std::string& name);
  EvaluatedScalar Evaluate(const std::string& expression) const;
  double EvaluateAs(const std::string& expression, const std::string& expectedType) const;
  std::string ToJson() const;
  void FromJson(const JsonValue& value);
  bool Empty() const { return myVariables.empty(); }

private:
  EvaluatedScalar evaluateVariable(const std::string& name,
                                   std::map<std::string, bool>& visiting) const;
  std::map<std::string, ScalarVariable> myVariables;
};

struct CoordinateSystemRecord
{
  std::string Id;
  std::string Name;
  std::array<double, 3> Origin{0.0, 0.0, 0.0};
  std::array<double, 3> XAxis{1.0, 0.0, 0.0};
  std::array<double, 3> YAxis{0.0, 1.0, 0.0};
  std::string Kind = "cartesian";
  std::string ReferenceBodyId;
  std::string ReferenceTopologyId;
  std::string AssociationMode = "snapshot";
  std::string ReferenceBodyIdentity;
  std::string ReferenceFeatureId;
  std::string ReferenceFeatureIdentity;
  std::string ReferenceSelector;
  std::string ReferenceState = "snapshot";
  std::string ReferenceDiagnostic;
  int ResolvedFaceIndex = 0;
};

class CoordinateSystemStore
{
public:
  void Clear();
  void Set(const CoordinateSystemRecord& record);
  void Delete(const std::string& id);
  const CoordinateSystemRecord& Get(const std::string& id) const;
  std::string ToJson(bool includePrivateReferences = false) const;
  void FromJson(const JsonValue& value);
  const std::map<std::string, CoordinateSystemRecord>& Records() const { return myRecords; }
private:
  std::map<std::string, CoordinateSystemRecord> myRecords;
};

struct MaterialPropertyRecord
{
  std::string Type = "double";
  bool BooleanValue = false;
  int IntegerValue = 0;
  double DoubleValue = 0.0;
  std::string Expression;
  std::string Dimension = "dimensionless";
  double ResolvedValue = 0.0;
};

struct MaterialRecord
{
  std::string Name;
  std::string Category = "dielectric";
  double RelativePermittivity = 1.0;
  double Conductivity = 0.0;
  std::string Color = "#7b91aa";
  bool BuiltIn = false;
  std::map<std::string, MaterialPropertyRecord> CustomProperties;
};

class MaterialStore
{
public:
  void ResetDefaults();
  void Set(const MaterialRecord& record);
  void SetProperty(const std::string& materialName, const std::string& key, const MaterialPropertyRecord& property);
  void DeleteProperty(const std::string& materialName, const std::string& key);
  void ResolveExpressions(const ScalarVariableStore& variables);
  void Delete(const std::string& name);
  bool Contains(const std::string& name) const;
  std::string ToJson() const;
  void FromJson(const JsonValue& value);
private:
  std::map<std::string, MaterialRecord> myRecords;
};

std::string ScalarDimensionName(ScalarDimension dimension);
ScalarDimension ParseScalarDimension(const std::string& type);
}
