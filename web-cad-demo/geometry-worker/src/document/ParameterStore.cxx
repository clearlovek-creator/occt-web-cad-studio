#include "ParameterStore.hxx"

#include "CadError.hxx"

#include <algorithm>
#include <cctype>
#include <cmath>
#include <iomanip>
#include <functional>
#include <sstream>
#include <vector>

namespace
{
using occweb::CadError;
using occweb::EvaluatedScalar;
using occweb::ScalarDimension;

bool validCoordinateId(const std::string& id)
{
  if (id.empty() || id.size() > 64) return false;
  return std::all_of(id.begin(), id.end(), [](const unsigned char c) { return c >= 0x20 && c != 0x7f && c != ','; });
}

bool validMaterialPropertyKey(const std::string& key)
{
  if (key.empty() || key.size() > 128) return false;
  return std::all_of(key.begin(), key.end(), [](const unsigned char c) { return c >= 0x20 && c != 0x7f; });
}

void validateMaterialProperty(const std::string& key, const occweb::MaterialPropertyRecord& property)
{
  if (!validMaterialPropertyKey(key))
    throw CadError("INVALID_MATERIAL_PROPERTY_KEY", "Material property key must contain 1-128 printable characters.");
  if (property.Type == "bool" || property.Type == "int") return;
  if (property.Type == "double")
  {
    if (!std::isfinite(property.DoubleValue)) throw CadError("INVALID_MATERIAL_PROPERTY", "Material double property must be finite.");
    return;
  }
  if (property.Type == "expression")
  {
    if (property.Expression.empty() || property.Expression.size() > 512)
      throw CadError("INVALID_MATERIAL_PROPERTY", "Material expression must contain 1-512 characters.");
    if (property.Dimension != "length" && property.Dimension != "angle"
        && property.Dimension != "dimensionless" && property.Dimension != "integer")
      throw CadError("INVALID_MATERIAL_PROPERTY", "Material expression dimension is invalid.");
    if (!std::isfinite(property.ResolvedValue))
      throw CadError("INVALID_MATERIAL_PROPERTY", "Material expression resolved value must be finite.");
    return;
  }
  throw CadError("INVALID_MATERIAL_PROPERTY_TYPE", "Material property type must be bool, int, double or expression.");
}
bool validName(const std::string& name)
{
  if (name.empty() || name.size() > 64 || (!std::isalpha(static_cast<unsigned char>(name[0])) && name[0] != '_')) return false;
  return std::all_of(name.begin() + 1, name.end(), [](const unsigned char c) { return std::isalnum(c) || c == '_'; });
}

bool isPlainNumber(const std::string& text)
{
  std::size_t parsed = 0;
  try { std::stod(text, &parsed); } catch (...) { return false; }
  while (parsed < text.size() && std::isspace(static_cast<unsigned char>(text[parsed]))) ++parsed;
  return parsed == text.size();
}

EvaluatedScalar add(const EvaluatedScalar& left, const EvaluatedScalar& right, const double sign)
{
  if (left.Dimension != right.Dimension)
    throw CadError("DIMENSION_MISMATCH", "Addition and subtraction require matching scalar dimensions.");
  return {left.Value + sign * right.Value, left.Dimension};
}

EvaluatedScalar multiply(const EvaluatedScalar& left, const EvaluatedScalar& right)
{
  if (left.Dimension == ScalarDimension::Dimensionless || left.Dimension == ScalarDimension::Integer)
    return {left.Value * right.Value, right.Dimension};
  if (right.Dimension == ScalarDimension::Dimensionless || right.Dimension == ScalarDimension::Integer)
    return {left.Value * right.Value, left.Dimension};
  throw CadError("DIMENSION_MISMATCH", "Multiplication requires at least one dimensionless operand.");
}

EvaluatedScalar divide(const EvaluatedScalar& left, const EvaluatedScalar& right)
{
  if (std::abs(right.Value) < 1.0e-15) throw CadError("DIVIDE_BY_ZERO", "Scalar expression divides by zero.");
  if (right.Dimension == ScalarDimension::Dimensionless || right.Dimension == ScalarDimension::Integer)
    return {left.Value / right.Value, left.Dimension};
  if (left.Dimension == right.Dimension) return {left.Value / right.Value, ScalarDimension::Dimensionless};
  throw CadError("DIMENSION_MISMATCH", "Division has incompatible scalar dimensions.");
}

class Parser
{
public:
  Parser(const std::string& text, const std::function<EvaluatedScalar(const std::string&)>& variable)
      : myText(text), myVariable(variable) {}

  EvaluatedScalar Parse()
  {
    EvaluatedScalar result = expression();
    whitespace();
    if (myPosition != myText.size()) fail("Unexpected token in scalar expression.");
    if (!std::isfinite(result.Value)) fail("Scalar expression produced a non-finite value.");
    return result;
  }

private:
  EvaluatedScalar expression()
  {
    EvaluatedScalar result = term();
    while (true)
    {
      whitespace();
      if (consume('+')) result = add(result, term(), 1.0);
      else if (consume('-')) result = add(result, term(), -1.0);
      else return result;
    }
  }

  EvaluatedScalar term()
  {
    EvaluatedScalar result = unary();
    while (true)
    {
      whitespace();
      if (consume('*')) result = multiply(result, unary());
      else if (consume('/')) result = divide(result, unary());
      else return result;
    }
  }

  EvaluatedScalar unary()
  {
    whitespace();
    if (consume('+')) return unary();
    if (consume('-')) { EvaluatedScalar value = unary(); value.Value = -value.Value; return value; }
    return primary();
  }

  EvaluatedScalar primary()
  {
    whitespace();
    if (consume('('))
    {
      EvaluatedScalar result = expression();
      whitespace();
      if (!consume(')')) fail("Missing ')' in scalar expression.");
      return result;
    }
    if (myPosition < myText.size() && (std::isdigit(static_cast<unsigned char>(myText[myPosition])) || myText[myPosition] == '.'))
      return number();
    const std::string name = identifier();
    whitespace();
    if (!consume('(')) return myVariable(name);
    std::vector<EvaluatedScalar> args;
    whitespace();
    if (!consume(')'))
    {
      do { args.push_back(expression()); whitespace(); } while (consume(','));
      if (!consume(')')) fail("Missing ')' after scalar function arguments.");
    }
    if ((name == "min" || name == "max") && args.size() == 2)
    {
      if (args[0].Dimension != args[1].Dimension) throw CadError("DIMENSION_MISMATCH", name + " requires matching dimensions.");
      return {(name == "min" ? std::min(args[0].Value, args[1].Value) : std::max(args[0].Value, args[1].Value)), args[0].Dimension};
    }
    if (name == "abs" && args.size() == 1) return {std::abs(args[0].Value), args[0].Dimension};
    if (name == "sqrt" && args.size() == 1)
    {
      if (args[0].Dimension != ScalarDimension::Dimensionless && args[0].Dimension != ScalarDimension::Integer)
        throw CadError("DIMENSION_MISMATCH", "sqrt currently accepts only dimensionless values.");
      if (args[0].Value < 0.0) throw CadError("INVALID_EXPRESSION", "sqrt requires a non-negative value.");
      return {std::sqrt(args[0].Value), ScalarDimension::Dimensionless};
    }
    if ((name == "sin" || name == "cos" || name == "tan") && args.size() == 1)
    {
      if (args[0].Dimension != ScalarDimension::Angle && args[0].Dimension != ScalarDimension::Dimensionless)
        throw CadError("DIMENSION_MISMATCH", name + " requires an angle or dimensionless value.");
      const double radians = args[0].Dimension == ScalarDimension::Angle ? args[0].Value * 3.14159265358979323846 / 180.0 : args[0].Value;
      return {name == "sin" ? std::sin(radians) : name == "cos" ? std::cos(radians) : std::tan(radians), ScalarDimension::Dimensionless};
    }
    throw CadError("INVALID_EXPRESSION", "Unknown scalar function or invalid argument count: " + name);
  }

  EvaluatedScalar number()
  {
    const std::size_t start = myPosition;
    while (myPosition < myText.size() && (std::isdigit(static_cast<unsigned char>(myText[myPosition])) || myText[myPosition] == '.' || myText[myPosition] == 'e' || myText[myPosition] == 'E' || myText[myPosition] == '+' || myText[myPosition] == '-'))
    {
      if ((myText[myPosition] == '+' || myText[myPosition] == '-') && myPosition > start && myText[myPosition - 1] != 'e' && myText[myPosition - 1] != 'E') break;
      ++myPosition;
    }
    double value = 0.0;
    try { value = std::stod(myText.substr(start, myPosition - start)); }
    catch (...) { fail("Invalid number in scalar expression."); }
    whitespace();
    const std::size_t unitStart = myPosition;
    while (myPosition < myText.size() && std::isalpha(static_cast<unsigned char>(myText[myPosition]))) ++myPosition;
    const std::string unit = myText.substr(unitStart, myPosition - unitStart);
    if (unit.empty()) return {value, ScalarDimension::Dimensionless};
    if (unit == "mm") return {value, ScalarDimension::Length};
    if (unit == "cm") return {value * 10.0, ScalarDimension::Length};
    if (unit == "m") return {value * 1000.0, ScalarDimension::Length};
    if (unit == "deg") return {value, ScalarDimension::Angle};
    if (unit == "rad") return {value * 180.0 / 3.14159265358979323846, ScalarDimension::Angle};
    throw CadError("INVALID_UNIT", "Unsupported scalar unit: " + unit);
  }

  std::string identifier()
  {
    whitespace();
    const std::size_t start = myPosition;
    if (myPosition >= myText.size() || (!std::isalpha(static_cast<unsigned char>(myText[myPosition])) && myText[myPosition] != '_')) fail("Expected a number or variable name.");
    ++myPosition;
    while (myPosition < myText.size() && (std::isalnum(static_cast<unsigned char>(myText[myPosition])) || myText[myPosition] == '_')) ++myPosition;
    return myText.substr(start, myPosition - start);
  }
  void whitespace() { while (myPosition < myText.size() && std::isspace(static_cast<unsigned char>(myText[myPosition]))) ++myPosition; }
  bool consume(const char value) { if (myPosition < myText.size() && myText[myPosition] == value) { ++myPosition; return true; } return false; }
  [[noreturn]] void fail(const std::string& message) const { throw CadError("INVALID_EXPRESSION", message); }

  const std::string& myText;
  std::function<EvaluatedScalar(const std::string&)> myVariable;
  std::size_t myPosition = 0;
};

std::string arrayJson(const std::array<double, 3>& values)
{
  std::ostringstream out;
  out << std::setprecision(17) << '[' << values[0] << ',' << values[1] << ',' << values[2] << ']';
  return out.str();
}
}

namespace occweb
{
std::string ScalarDimensionName(const ScalarDimension dimension)
{
  switch (dimension)
  {
    case ScalarDimension::Length: return "length";
    case ScalarDimension::Angle: return "angle";
    case ScalarDimension::Integer: return "integer";
    default: return "dimensionless";
  }
}

ScalarDimension ParseScalarDimension(const std::string& type)
{
  if (type == "length") return ScalarDimension::Length;
  if (type == "angle") return ScalarDimension::Angle;
  if (type == "dimensionless") return ScalarDimension::Dimensionless;
  if (type == "integer") return ScalarDimension::Integer;
  throw CadError("INVALID_VARIABLE_TYPE", "Variable type must be length, angle, dimensionless or integer.");
}

void ScalarVariableStore::Clear() { myVariables.clear(); }

EvaluatedScalar ScalarVariableStore::evaluateVariable(const std::string& name, std::map<std::string, bool>& visiting) const
{
  const auto found = myVariables.find(name);
  if (found == myVariables.end()) throw CadError("UNDEFINED_VARIABLE", "Undefined scalar variable: " + name);
  if (visiting[name]) throw CadError("VARIABLE_CYCLE", "Scalar variable dependency cycle contains: " + name);
  visiting[name] = true;
  Parser parser(found->second.Expression, [&](const std::string& dependency) { return evaluateVariable(dependency, visiting); });
  EvaluatedScalar value = parser.Parse();
  visiting[name] = false;
  if (value.Dimension == ScalarDimension::Dimensionless && (found->second.Dimension == ScalarDimension::Length || found->second.Dimension == ScalarDimension::Angle) && isPlainNumber(found->second.Expression))
    value.Dimension = found->second.Dimension;
  if (value.Dimension == ScalarDimension::Dimensionless && found->second.Dimension == ScalarDimension::Integer && std::floor(value.Value) == value.Value)
    value.Dimension = ScalarDimension::Integer;
  if (value.Dimension != found->second.Dimension)
    throw CadError("DIMENSION_MISMATCH", "Variable '" + name + "' does not match its declared type.");
  if (found->second.Dimension == ScalarDimension::Integer && std::floor(value.Value) != value.Value)
    throw CadError("INVALID_VARIABLE_VALUE", "Integer variable must evaluate to a whole number.");
  return value;
}

EvaluatedScalar ScalarVariableStore::Evaluate(const std::string& expression) const
{
  std::map<std::string, bool> visiting;
  Parser parser(expression, [&](const std::string& name) { return evaluateVariable(name, visiting); });
  return parser.Parse();
}

double ScalarVariableStore::EvaluateAs(const std::string& expression, const std::string& expectedType) const
{
  EvaluatedScalar value = Evaluate(expression);
  const ScalarDimension expected = ParseScalarDimension(expectedType);
  if (value.Dimension == ScalarDimension::Dimensionless && (expected == ScalarDimension::Length || expected == ScalarDimension::Angle) && isPlainNumber(expression))
    value.Dimension = expected;
  if (value.Dimension == ScalarDimension::Dimensionless && expected == ScalarDimension::Integer && std::floor(value.Value) == value.Value)
    value.Dimension = ScalarDimension::Integer;
  if (value.Dimension != expected)
    throw CadError("DIMENSION_MISMATCH", "Scalar expression does not match expected " + expectedType + " dimension.");
  return value.Value;
}

void ScalarVariableStore::Set(const std::string& name, const std::string& type, const std::string& expression)
{
  if (!validName(name)) throw CadError("INVALID_VARIABLE_NAME", "Variable name must be a valid identifier with at most 64 characters.");
  if (expression.empty() || expression.size() > 512) throw CadError("INVALID_EXPRESSION", "Variable expression must contain 1-512 characters.");
  const auto previous = myVariables.find(name);
  const bool existed = previous != myVariables.end();
  const ScalarVariable backup = existed ? previous->second : ScalarVariable{};
  myVariables[name] = {name, ParseScalarDimension(type), expression, 0.0};
  try
  {
    for (auto& [variableName, variable] : myVariables)
      variable.Value = Evaluate(variableName).Value;
  }
  catch (...)
  {
    if (existed) myVariables[name] = backup; else myVariables.erase(name);
    throw;
  }
}

void ScalarVariableStore::Delete(const std::string& name)
{
  const auto found = myVariables.find(name);
  if (found == myVariables.end()) throw CadError("VARIABLE_NOT_FOUND", "Scalar variable does not exist: " + name);
  const ScalarVariable backup = found->second;
  myVariables.erase(found);
  try { for (const auto& [variableName, unused] : myVariables) Evaluate(variableName); }
  catch (...) { myVariables[name] = backup; throw CadError("VARIABLE_IN_USE", "Scalar variable is referenced by another variable."); }
}

std::string ScalarVariableStore::ToJson() const
{
  std::ostringstream out;
  out << std::setprecision(17) << '[';
  bool first = true;
  for (const auto& [name, variable] : myVariables)
  {
    if (!first) out << ',';
    out << "{\"name\":\"" << JsonEscape(name) << "\",\"type\":\"" << ScalarDimensionName(variable.Dimension)
        << "\",\"expression\":\"" << JsonEscape(variable.Expression) << "\",\"value\":" << variable.Value << '}';
    first = false;
  }
  out << ']';
  return out.str();
}

void ScalarVariableStore::FromJson(const JsonValue& value)
{
  myVariables.clear();
  for (const JsonValue& item : value.AsArray())
    myVariables[item.GetString("name")] = {item.GetString("name"), ParseScalarDimension(item.GetString("type")), item.GetString("expression"), item.GetNumberOr("value", 0.0)};
  for (auto& [name, variable] : myVariables) variable.Value = Evaluate(name).Value;
}

void CoordinateSystemStore::Clear() { myRecords.clear(); }

void CoordinateSystemStore::Set(const CoordinateSystemRecord& record)
{
  if (record.Id == "global") throw CadError("BUILT_IN_COORDINATE_SYSTEM", "The Global coordinate system is immutable. Create a local system instead.");
  if (record.AssociationMode!="snapshot" && record.AssociationMode!="associative")
    throw CadError("INVALID_COORDINATE_REFERENCE","Unsupported coordinate association mode.");
  if (record.AssociationMode=="associative")
  {
    if (record.Kind!="face" || record.ReferenceBodyIdentity.size()!=32 || record.ReferenceFeatureIdentity.size()!=32
        || record.ReferenceFeatureId.empty() || record.ReferenceSelector.empty() || record.ReferenceSelector.size()>512*1024
        || (record.ReferenceState!="resolved" && record.ReferenceState!="unresolved"))
      throw CadError("INVALID_COORDINATE_REFERENCE","Incomplete persistent face coordinate reference.");
    const auto selector=JsonParser(record.ReferenceSelector).Parse();
    if (selector.GetString("kind")!="face") throw CadError("INVALID_COORDINATE_REFERENCE","A face coordinate cannot reference an Edge selector.");
  }
  if (!validCoordinateId(record.Id) || record.Name.empty() || record.Name.size() > 128) throw CadError("INVALID_COORDINATE_SYSTEM", "Coordinate system id must be an identifier and name must contain 1-128 characters.");
  const auto length2 = [](const std::array<double, 3>& v) { return v[0]*v[0] + v[1]*v[1] + v[2]*v[2]; };
  for (const auto& vector : {record.Origin,record.XAxis,record.YAxis})
    if (!std::all_of(vector.begin(),vector.end(),[](double value){return std::isfinite(value);}))
      throw CadError("INVALID_COORDINATE_SYSTEM", "Coordinate system vectors must contain finite numbers.");
  const double dot = record.XAxis[0]*record.YAxis[0] + record.XAxis[1]*record.YAxis[1] + record.XAxis[2]*record.YAxis[2];
  const double xLength2=length2(record.XAxis),yLength2=length2(record.YAxis);
  if (!std::isfinite(xLength2) || !std::isfinite(yLength2) || !std::isfinite(dot)
      || xLength2 < 1.0e-24 || yLength2 < 1.0e-24 || std::abs(dot)/std::sqrt(xLength2)/std::sqrt(yLength2) > 0.999999)
    throw CadError("INVALID_COORDINATE_SYSTEM", "Coordinate system axes must be finite, non-zero and non-parallel.");
  myRecords[record.Id] = record;
}

void CoordinateSystemStore::Delete(const std::string& id)
{
  if (id == "global") throw CadError("COORDINATE_SYSTEM_IN_USE", "The global coordinate system cannot be deleted.");
  if (myRecords.erase(id) == 0) throw CadError("COORDINATE_SYSTEM_NOT_FOUND", "Coordinate system does not exist: " + id);
}

const CoordinateSystemRecord& CoordinateSystemStore::Get(const std::string& id) const
{
  static const CoordinateSystemRecord global{"global", "Global", {0,0,0}, {1,0,0}, {0,1,0}};
  if (id.empty() || id == "global") return global;
  const auto found = myRecords.find(id);
  if (found == myRecords.end()) throw CadError("COORDINATE_SYSTEM_NOT_FOUND", "Coordinate system does not exist: " + id);
  if (found->second.AssociationMode == "associative" && found->second.ReferenceState != "resolved")
    throw CadError("COORDINATE_REFERENCE_UNRESOLVED", "面坐标系 " + id + " 的引用失效，请重新关联有效面；未采用旧坐标快照。",
      "{\"coordinateSystemId\":\"" + JsonEscape(id) + "\"}");
  return found->second;
}

std::string CoordinateSystemStore::ToJson(const bool includePrivateReferences) const
{
  std::ostringstream out;
  out << "[{\"id\":\"global\",\"name\":\"Global\",\"origin\":[0,0,0],\"xAxis\":[1,0,0],\"yAxis\":[0,1,0],\"builtIn\":true}";
  for (const auto& [id, record] : myRecords)
  {
    out << ",{\"id\":\"" << JsonEscape(id) << "\",\"name\":\"" << JsonEscape(record.Name)
        << "\",\"origin\":" << arrayJson(record.Origin) << ",\"xAxis\":" << arrayJson(record.XAxis)
        << ",\"yAxis\":" << arrayJson(record.YAxis) << ",\"kind\":\"" << JsonEscape(record.Kind)
        << "\",\"referenceBodyId\":\"" << JsonEscape(record.ReferenceBodyId)
        << "\",\"referenceTopologyId\":\"" << JsonEscape(record.ReferenceTopologyId)
        << "\",\"associationMode\":\"" << JsonEscape(record.AssociationMode)
        << "\",\"referenceFeatureId\":\"" << JsonEscape(record.ReferenceFeatureId)
        << "\",\"referenceState\":\"" << JsonEscape(record.ReferenceState)
        << "\",\"referenceDiagnostic\":\"" << JsonEscape(record.ReferenceDiagnostic)
        << "\",\"resolvedFaceIndex\":" << record.ResolvedFaceIndex;
    if (includePrivateReferences)
      out << ",\"referenceBodyIdentity\":\"" << JsonEscape(record.ReferenceBodyIdentity)
          << "\",\"referenceFeatureIdentity\":\"" << JsonEscape(record.ReferenceFeatureIdentity)
          << "\",\"referenceSelector\":\"" << JsonEscape(record.ReferenceSelector) << '"';
    out << ",\"builtIn\":false}";
  }
  out << ']';
  return out.str();
}

void CoordinateSystemStore::FromJson(const JsonValue& value)
{
  myRecords.clear();
  for (const JsonValue& item : value.AsArray())
  {
    if (item.GetBooleanOr("builtIn", false) || item.GetString("id") == "global") continue;
    CoordinateSystemRecord record;
    record.Id = item.GetString("id"); record.Name = item.GetString("name");
    const auto read = [](const JsonValue& array) { return std::array<double,3>{array.AsArray().at(0).AsNumber(), array.AsArray().at(1).AsNumber(), array.AsArray().at(2).AsNumber()}; };
    record.Origin = read(item.At("origin")); record.XAxis = read(item.At("xAxis")); record.YAxis = read(item.At("yAxis"));
    record.Kind = item.GetStringOr("kind", "cartesian");
    record.ReferenceBodyId = item.GetStringOr("referenceBodyId", "");
    record.ReferenceTopologyId = item.GetStringOr("referenceTopologyId", "");
    record.AssociationMode = item.GetStringOr("associationMode", "snapshot");
    record.ReferenceBodyIdentity = item.GetStringOr("referenceBodyIdentity", "");
    record.ReferenceFeatureId = item.GetStringOr("referenceFeatureId", "");
    record.ReferenceFeatureIdentity = item.GetStringOr("referenceFeatureIdentity", "");
    record.ReferenceSelector = item.GetStringOr("referenceSelector", "");
    record.ReferenceState = item.GetStringOr("referenceState", "snapshot");
    record.ReferenceDiagnostic = item.GetStringOr("referenceDiagnostic", "");
    record.ResolvedFaceIndex = item.GetIntegerOr("resolvedFaceIndex", 0);
    if (record.AssociationMode != "snapshot" && record.AssociationMode != "associative")
      throw CadError("INVALID_COORDINATE_REFERENCE", "Unsupported coordinate reference association mode.");
    if (record.AssociationMode == "associative"
        && (record.ReferenceBodyIdentity.empty() || record.ReferenceFeatureId.empty()
            || record.ReferenceFeatureIdentity.empty() || record.ReferenceSelector.empty()))
      throw CadError("INVALID_COORDINATE_REFERENCE", "An associative coordinate requires its complete persistent reference.");
    Set(record);
  }
}

void MaterialStore::ResetDefaults()
{
  myRecords.clear();
  const auto add = [&](const std::string& name, const std::string& category, const double epsilon,
                       const double conductivity, const std::string& color)
  {
    myRecords[name] = {name, category, epsilon, conductivity, color, true};
  };
  add("Vacuum", "vacuum", 1.0, 0.0, "#dbeafe");
  add("PEC", "conductor", 1.0, 1.0e30, "#b8c2cc");
  add("Aluminum", "conductor", 1.0, 3.56e7, "#b9c0c8");
  add("Copper", "conductor", 1.0, 5.8e7, "#b87333");
  add("Steel", "conductor", 1.0, 1.45e6, "#8a9299");
}

void MaterialStore::Set(const MaterialRecord& record)
{
  if (record.Name.empty() || record.Name.size() > 128
      || !std::all_of(record.Name.begin(), record.Name.end(), [](const unsigned char c) { return c >= 0x20 && c != 0x7f && c != ','; }))
    throw CadError("INVALID_MATERIAL_NAME", "Material name must contain 1-128 printable characters and cannot contain commas.");
  if (record.Category != "vacuum" && record.Category != "dielectric" && record.Category != "conductor")
    throw CadError("INVALID_MATERIAL_CATEGORY", "Material category must be vacuum, dielectric or conductor.");
  if (!std::isfinite(record.RelativePermittivity) || record.RelativePermittivity <= 0.0
      || !std::isfinite(record.Conductivity) || record.Conductivity < 0.0)
    throw CadError("INVALID_MATERIAL_PROPERTY", "Material permittivity must be positive and conductivity cannot be negative.");
  if (record.Color.size() != 7 || record.Color[0] != '#'
      || !std::all_of(record.Color.begin() + 1, record.Color.end(), [](const unsigned char c) { return std::isxdigit(c); }))
    throw CadError("INVALID_MATERIAL_COLOR", "Material color must use #RRGGBB format.");
  for (const auto& [key, property] : record.CustomProperties) validateMaterialProperty(key, property);
  const auto existing = myRecords.find(record.Name);
  if (existing != myRecords.end() && existing->second.BuiltIn)
    throw CadError("BUILT_IN_MATERIAL", "Built-in materials cannot be modified.");
  myRecords[record.Name] = record;
}

void MaterialStore::SetProperty(const std::string& materialName, const std::string& key,
                                const MaterialPropertyRecord& property)
{
  const auto found = myRecords.find(materialName);
  if (found == myRecords.end()) throw CadError("MATERIAL_NOT_FOUND", "Material does not exist: " + materialName);
  if (found->second.BuiltIn) throw CadError("BUILT_IN_MATERIAL", "Built-in materials cannot be modified.");
  validateMaterialProperty(key, property);
  found->second.CustomProperties[key] = property;
}

void MaterialStore::DeleteProperty(const std::string& materialName, const std::string& key)
{
  const auto found = myRecords.find(materialName);
  if (found == myRecords.end()) throw CadError("MATERIAL_NOT_FOUND", "Material does not exist: " + materialName);
  if (found->second.BuiltIn) throw CadError("BUILT_IN_MATERIAL", "Built-in materials cannot be modified.");
  found->second.CustomProperties.erase(key);
}
void MaterialStore::ResolveExpressions(const ScalarVariableStore& variables)
{
  for (auto& [name, record] : myRecords)
    for (auto& [key, property] : record.CustomProperties)
      if (property.Type == "expression")
        property.ResolvedValue = variables.EvaluateAs(property.Expression, property.Dimension);
}
void MaterialStore::Delete(const std::string& name)
{
  const auto found = myRecords.find(name);
  if (found == myRecords.end()) throw CadError("MATERIAL_NOT_FOUND", "Material does not exist: " + name);
  if (found->second.BuiltIn) throw CadError("BUILT_IN_MATERIAL", "Built-in materials cannot be deleted.");
  myRecords.erase(found);
}

bool MaterialStore::Contains(const std::string& name) const
{
  return myRecords.find(name) != myRecords.end();
}

std::string MaterialStore::ToJson() const
{
  std::ostringstream out;
  out << std::setprecision(17) << '[';
  bool first = true;
  for (const auto& [name, record] : myRecords)
  {
    if (!first) out << ',';
    out << "{\"name\":\"" << JsonEscape(name) << "\",\"category\":\"" << JsonEscape(record.Category)
        << "\",\"relativePermittivity\":" << record.RelativePermittivity
        << ",\"conductivity\":" << record.Conductivity << ",\"color\":\"" << JsonEscape(record.Color)
        << "\",\"builtIn\":" << (record.BuiltIn ? "true" : "false");
    if (!record.CustomProperties.empty())
    {
      out << ",\"customProperties\":{";
      bool firstProperty = true;
      for (const auto& [key, property] : record.CustomProperties)
      {
        if (!firstProperty) out << ',';
        out << "\"" << JsonEscape(key) << "\":{\"type\":\"" << property.Type << "\"";
        if (property.Type == "bool") out << ",\"value\":" << (property.BooleanValue ? "true" : "false");
        else if (property.Type == "int") out << ",\"value\":" << property.IntegerValue;
        else if (property.Type == "double") out << ",\"value\":" << property.DoubleValue;
        else out << ",\"expression\":\"" << JsonEscape(property.Expression) << "\",\"dimension\":\""
                 << JsonEscape(property.Dimension) << "\",\"resolvedValue\":" << property.ResolvedValue;
        out << '}';
        firstProperty = false;
      }
      out << '}';
    }
    out << '}';
    first = false;
  }
  out << ']';
  return out.str();
}
void MaterialStore::FromJson(const JsonValue& value)
{
  ResetDefaults();
  for (const JsonValue& item : value.AsArray())
  {
    if (item.GetBooleanOr("builtIn", false)) continue;
    MaterialRecord record;
    record.Name = item.GetString("name");
    record.Category = item.GetStringOr("category", "dielectric");
    record.RelativePermittivity = item.GetNumberOr("relativePermittivity", 1.0);
    record.Conductivity = item.GetNumberOr("conductivity", 0.0);
    record.Color = item.GetStringOr("color", "#7b91aa");
    if (const JsonValue* custom = item.Find("customProperties"))
    {
      if (!custom->IsObject()) throw CadError("INVALID_MATERIAL_PROPERTY", "customProperties must be an object.");
      for (const auto& [key, value] : custom->AsObject())
      {
        if (!value.IsObject()) throw CadError("INVALID_MATERIAL_PROPERTY", "Each material property must be an object.");
        MaterialPropertyRecord property;
        property.Type = value.GetStringOr("type", "");
        if (property.Type == "bool") property.BooleanValue = value.At("value").AsBoolean();
        else if (property.Type == "int") property.IntegerValue = value.At("value").AsInteger();
        else if (property.Type == "double") property.DoubleValue = value.At("value").AsNumber();
        else if (property.Type == "expression")
        {
          property.Expression = value.GetString("expression");
          property.Dimension = value.GetStringOr("dimension", "dimensionless");
          property.ResolvedValue = value.GetNumberOr("resolvedValue", 0.0);
        }
        record.CustomProperties[key] = property;
      }
    }
    Set(record);
  }
}
}
