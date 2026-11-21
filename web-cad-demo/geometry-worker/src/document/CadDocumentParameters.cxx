#include "CadDocument.hxx"
#include "BodyDisplayMetadata.hxx"

#include "CadError.hxx"
#include "CoordinateReference.hxx"
#include "../features/PatternIdentity.hxx"
#include "../presentation/ShapeSerializer.hxx"
#include <BRepAdaptor_Surface.hxx>
#include <TopoDS.hxx>
#include <gp_Pnt.hxx>
#include <gp_Ax3.hxx>
#include <gp_Dir.hxx>
#include <gp_Trsf.hxx>
#include <gp_Vec.hxx>

#include <algorithm>
#include <array>
#include <cctype>
#include <cmath>

namespace
{
std::array<double, 3> vector3(const occweb::JsonValue& parameters, const std::string& key,
                             const std::array<double, 3>& fallback)
{
  const occweb::JsonValue* value = parameters.Find(key);
  if (value == nullptr) return fallback;
  const auto& items = value->AsArray();
  if (items.size() != 3) throw occweb::CadError("INVALID_PARAMETER", key + " must contain exactly three numbers.");
  std::array<double, 3> result{items[0].AsNumber(), items[1].AsNumber(), items[2].AsNumber()};
  if (!std::all_of(result.begin(), result.end(), [](const double number) { return std::isfinite(number); }))
    throw occweb::CadError("INVALID_PARAMETER", key + " must contain finite numbers.");
  return result;
}

occweb::MaterialPropertyRecord parseMaterialProperty(const occweb::JsonValue& value,
                                                     const occweb::ScalarVariableStore& variables)
{
  if (!value.IsObject()) throw occweb::CadError("INVALID_MATERIAL_PROPERTY", "Material property must be an object.");
  occweb::MaterialPropertyRecord property;
  property.Type = value.GetStringOr("type", "");
  if (property.Type == "bool")
  {
    property.BooleanValue = value.At("value").AsBoolean();
  }
  else if (property.Type == "int")
  {
    property.IntegerValue = value.At("value").AsInteger();
  }
  else if (property.Type == "double")
  {
    property.DoubleValue = value.At("value").AsNumber();
  }
  else if (property.Type == "expression")
  {
    property.Expression = value.GetString("expression");
    property.Dimension = value.GetStringOr("dimension", "dimensionless");
    property.ResolvedValue = variables.EvaluateAs(property.Expression, property.Dimension);
  }
  else
  {
    throw occweb::CadError("INVALID_MATERIAL_PROPERTY_TYPE", "Material property type must be bool, int, double or expression.");
  }
  return property;
}
bool validColor(const std::string& color)
{
  if (color.size() != 7 || color[0] != '#') return false;
  return std::all_of(color.begin() + 1, color.end(), [](const unsigned char character) { return std::isxdigit(character); });
}
}

namespace occweb
{
double CadDocument::parameterValue(const JsonValue& parameters, const std::string& key,
                                   const std::string& expectedType, const double fallback,
                                   const bool required, FeatureNode* feature) const
{
  const JsonValue* value = parameters.Find(key);
  if (value == nullptr)
  {
    if (required) throw CadError("MISSING_PARAMETER", "Missing modeling parameter: " + key);
    if (feature != nullptr) feature->NumberParameters[key] = fallback;
    return fallback;
  }
  double result = 0.0;
  if (value->IsNumber()) result = value->AsNumber();
  else if (value->IsString())
  {
    const std::string& expression = value->AsString();
    std::size_t parsed = 0;
    try
    {
      result = std::stod(expression, &parsed);
      while (parsed < expression.size() && std::isspace(static_cast<unsigned char>(expression[parsed]))) ++parsed;
      if (parsed != expression.size()) result = myVariables.EvaluateAs(expression, expectedType);
    }
    catch (const CadError&) { throw; }
    catch (...) { result = myVariables.EvaluateAs(expression, expectedType); }
    if (feature != nullptr) feature->StringParameters["expr." + key] = expression;
  }
  else throw CadError("INVALID_PARAMETER", "Modeling parameter must be a number or scalar expression: " + key);
  if (!std::isfinite(result)) throw CadError("INVALID_PARAMETER", "Modeling parameter must be finite: " + key);
  if (feature != nullptr) feature->NumberParameters[key] = result;
  return result;
}

std::string CadDocument::SetVariable(const std::string& requestId, const int expectedRevision,
                                     const JsonValue& parameters, const HistoricalInputTarget& inspectionTarget)
{
  if (expectedRevision != myRevision) throw CadError("STALE_REVISION", "Document revision is stale. Reload before editing variables.");
  const ScalarVariableStore backupVariables = myVariables;
  const MaterialStore backupMaterials = myMaterials;
  const std::vector<FeatureNode> backupFeatures = myFeatures;
  std::string firstDependentFeature;
  JsonValue recomputeParameters = JsonValue::MakeObject();
  recomputeParameters.ChangeObject()["__recomputeAll"] = JsonValue(true);
  if (const auto* edits = parameters.Find("selectionEdits")) recomputeParameters.ChangeObject()["selectionEdits"] = *edits;
  if (const auto* edits = parameters.Find("coordinateSelectionEdits")) recomputeParameters.ChangeObject()["coordinateSelectionEdits"] = *edits;
  try
  {
    // Variable evaluation replaces cached countX before replay starts. Capture
    // legacy grid ownership while these numbers still describe the live model.
    for(auto& feature:myFeatures)CapturePatternSlots(feature);
    myVariables.Set(parameters.GetString("name"), parameters.GetString("type"), parameters.GetString("expression"));
    for (FeatureNode& feature : myFeatures)
      for (const auto& [storedKey, expression] : feature.StringParameters)
      {
        if (storedKey.rfind("expr.", 0) != 0) continue;
        const std::string key = storedKey.substr(5);
        const std::string expectedType = ScalarParameterType(key);
        feature.NumberParameters[key] = myVariables.EvaluateAs(expression, expectedType);
        if (firstDependentFeature.empty())
        {
          firstDependentFeature = feature.Id;
          recomputeParameters.ChangeObject()[key] = JsonValue(expression);
        }
      }
    myMaterials.ResolveExpressions(myVariables);
    if (firstDependentFeature.empty() && (!inspectionTarget.empty() || parameters.Has("selectionEdits") || parameters.Has("coordinateSelectionEdits")))
    {
      if (myFeatures.empty()) throw CadError("FEATURE_INPUT_UNAVAILABLE", "There is no feature input to inspect or repair.");
      firstDependentFeature = myFeatures.front().Id;
      recomputeParameters.ChangeObject()["__lifecycleReplay"] = JsonValue(true);
    }
    if (!firstDependentFeature.empty())
      return replayFeatureEdit(requestId, myRevision, firstDependentFeature, recomputeParameters, inspectionTarget);
  }
  catch (...)
  {
    myVariables = backupVariables;
    myMaterials = backupMaterials;
    myFeatures = backupFeatures;
    throw;
  }
  ++myRevision;
  persistMetadata();
  return Summary(requestId);
}

std::string CadDocument::DeleteVariable(const std::string& requestId, const int expectedRevision,
                                        const std::string& name)
{
  if (expectedRevision != myRevision) throw CadError("STALE_REVISION", "Document revision is stale. Reload before deleting variables.");
  for (const FeatureNode& feature : myFeatures)
    for (const auto& [key, expression] : feature.StringParameters)
      if (key.rfind("expr.", 0) == 0 && expression.find(name) != std::string::npos)
        throw CadError("VARIABLE_IN_USE", "Variable is referenced by modeling feature " + feature.Id + '.');
  myVariables.Delete(name);
  ++myRevision;
  persistMetadata();
  return Summary(requestId);
}

std::string CadDocument::SetCoordinateSystem(const std::string& requestId, const int expectedRevision,
                                             const JsonValue& parameters, const HistoricalInputTarget& inspectionTarget)
{
  if (expectedRevision != myRevision) throw CadError("STALE_REVISION", "Document revision is stale. Reload before editing coordinate systems.");
  const CoordinateSystemStore backupCoordinates = myCoordinateSystems;
  const std::vector<FeatureNode> backupFeatures = myFeatures;
  try
  {
  CoordinateSystemRecord record;
  record.Id = parameters.GetString("id");
  record.Name = parameters.GetStringOr("name", record.Id);
  record.Kind = parameters.GetStringOr("kind", "cartesian");
  record.Origin = vector3(parameters, "origin", {0,0,0});
  record.XAxis = vector3(parameters, "xAxis", {1,0,0});
  record.YAxis = vector3(parameters, "yAxis", {0,1,0});
  if (record.Kind == "threePoint")
  {
    const auto xPoint = vector3(parameters, "xPoint", {1,0,0});
    const auto planePoint = vector3(parameters, "planePoint", {0,1,0});
    for (int index = 0; index < 3; ++index)
    {
      record.XAxis[index] = xPoint[index] - record.Origin[index];
      record.YAxis[index] = planePoint[index] - record.Origin[index];
    }
  }
  else if (record.Kind == "face")
  {
    if (parameters.GetBooleanOr("preserveReference", false) || parameters.Has("copyReferenceFrom"))
    {
      const auto copyFrom=parameters.GetStringOr("copyReferenceFrom","");
      const auto existing=myCoordinateSystems.Records().find(copyFrom.empty()?record.Id:copyFrom);
      if (existing==myCoordinateSystems.Records().end() || existing->second.Kind!="face")
        throw CadError("INVALID_COORDINATE_REFERENCE","没有可保留的面参考坐标系，请显式选择来源面。");
      if (!copyFrom.empty() && myCoordinateSystems.Records().count(record.Id))
        throw CadError("COORDINATE_SYSTEM_EXISTS","复制坐标系不能覆盖已有记录，请使用新的 ID。");
      const auto name=record.Name,id=record.Id;record=existing->second;record.Name=name;record.Id=id;
      const auto nextMode=parameters.GetStringOr("associationMode",record.AssociationMode);
      if (nextMode=="associative" && record.AssociationMode!="associative")
        throw CadError("INVALID_COORDINATE_REFERENCE","固定快照升级为关联坐标系需要显式重新选择当前有效面，不能使用旧面编号。");
      if (nextMode=="snapshot")
      {
        if (record.AssociationMode=="associative" && record.ReferenceState!="resolved")
          throw CadError("COORDINATE_REFERENCE_UNRESOLVED","引用失效的坐标系不能用旧位置冻结为有效快照，请先重新关联。");
        record.AssociationMode="snapshot";record.ReferenceState="snapshot";record.ReferenceDiagnostic.clear();
        record.ReferenceSelector.clear();record.ReferenceFeatureId.clear();record.ReferenceFeatureIdentity.clear();record.ReferenceBodyIdentity.clear();record.ResolvedFaceIndex=0;
      }
      else if (nextMode!="associative") throw CadError("INVALID_COORDINATE_REFERENCE","Unsupported coordinate association mode.");
    }
    else
    {
    record.ReferenceBodyId = parameters.GetString("referenceBodyId");
    record.ReferenceTopologyId = parameters.GetString("referenceTopologyId");
    validatePropertyTarget("face", record.ReferenceBodyId, record.ReferenceTopologyId);
    const BodyRecord& body = bodyOrActive(record.ReferenceBodyId);
    ShapeSerializer topology(body.Shape, body.TopologyRevision, body.Id);
    const int faceIndex = topology.FaceIndexFromId(record.ReferenceTopologyId);
    record.AssociationMode=parameters.GetStringOr("associationMode","associative");
    if (record.AssociationMode!="snapshot" && record.AssociationMode!="associative")
      throw CadError("INVALID_COORDINATE_REFERENCE","面坐标系关联模式必须为 associative 或 snapshot。");
    UpdateFaceCoordinateFrame(record,TopoDS::Face(topology.Faces()(faceIndex)),record.AssociationMode=="associative");
    if (record.AssociationMode=="associative")
    {
      const auto source=std::find_if(myFeatures.begin(),myFeatures.end(),[&](const auto& feature){return feature.Id==body.SourceFeatureId;});
      const auto identity=myEntityIdentities.find(body.Id);
      if (source==myFeatures.end() || identity==myEntityIdentities.end())
        throw CadError("INVALID_COORDINATE_REFERENCE","所选面缺少完整特征及 Body 身份，不能建立关联。");
      record.ReferenceSelector=TopologyNaming::CaptureSelection(body.Shape,body.Names,"face",faceIndex);
      if (source->Identity.empty()) source->Identity=newIdentity();
      record.ReferenceBodyIdentity=identity->second.Body;
      record.ReferenceFeatureId=source->Id;record.ReferenceFeatureIdentity=source->Identity;
      record.ReferenceState="resolved";record.ResolvedFaceIndex=faceIndex;
    }
    }
  }
  else if (record.Kind != "cartesian")
    throw CadError("INVALID_COORDINATE_SYSTEM", "Coordinate system kind must be cartesian, threePoint or face.");
  myCoordinateSystems.Set(record);

  std::string dependentFeature;
    for (FeatureNode& feature : myFeatures)
    {
      const auto system = feature.StringParameters.find("coordinateSystemId");
      if (system != feature.StringParameters.end() && system->second == record.Id)
      {
        if (dependentFeature.empty()) dependentFeature = feature.Id;
      }
      const auto source = feature.StringParameters.find("sourceCoordinateSystemId");
      const auto target = feature.StringParameters.find("targetCoordinateSystemId");
      if (source != feature.StringParameters.end() && target != feature.StringParameters.end()
          && (source->second == record.Id || target->second == record.Id))
      {
        if (dependentFeature.empty()) dependentFeature = feature.Id;
      }
    }
    if (dependentFeature.empty() && (!inspectionTarget.empty() || parameters.Has("selectionEdits") || parameters.Has("coordinateSelectionEdits")))
    {
      if (myFeatures.empty()) throw CadError("FEATURE_INPUT_UNAVAILABLE", "There is no feature input to inspect or repair.");
      dependentFeature = myFeatures.front().Id;
    }
    if (!dependentFeature.empty())
    {
      JsonValue update = JsonValue::MakeObject();
      update.ChangeObject()["__recomputeAll"] = JsonValue(true);
      update.ChangeObject()["__lifecycleReplay"] = JsonValue(true);
      if (const auto* edits = parameters.Find("selectionEdits")) update.ChangeObject()["selectionEdits"] = *edits;
      if (const auto* edits = parameters.Find("coordinateSelectionEdits")) update.ChangeObject()["coordinateSelectionEdits"] = *edits;
      return replayFeatureEdit(requestId, myRevision, dependentFeature, update, inspectionTarget);
    }
  }
  catch (...)
  {
    myCoordinateSystems = backupCoordinates;
    myFeatures = backupFeatures;
    throw;
  }
  ++myRevision;
  persistMetadata();
  return Summary(requestId);
}

std::string CadDocument::DeleteCoordinateSystem(const std::string& requestId, const int expectedRevision,
                                                const std::string& id)
{
  if (expectedRevision != myRevision) throw CadError("STALE_REVISION", "Document revision is stale. Reload before deleting coordinate systems.");
  for (const FeatureNode& feature : myFeatures)
  {
    const auto ids=FeatureCoordinateIds(feature);
    if (std::find(ids.begin(),ids.end(),id)!=ids.end())
      throw CadError("COORDINATE_SYSTEM_IN_USE", "Coordinate system is referenced by modeling feature " + feature.Id + '.');
  }
  myCoordinateSystems.Delete(id);
  ++myRevision;
  persistMetadata();
  return Summary(requestId);
}

std::string CadDocument::SetMaterial(const std::string& requestId, const int expectedRevision,
                                     const JsonValue& parameters)
{
  if (expectedRevision != myRevision) throw CadError("STALE_REVISION", "Document revision is stale. Reload before editing materials.");
  MaterialRecord record;
  record.Name = parameters.GetString("name");
  record.Category = parameters.GetStringOr("category", "dielectric");
  record.RelativePermittivity = parameters.GetNumberOr("relativePermittivity", 1.0);
  record.Conductivity = parameters.GetNumberOr("conductivity", 0.0);
  record.Color = parameters.GetStringOr("color", "#7b91aa");
  if (const JsonValue* custom = parameters.Find("customProperties"))
  {
    if (!custom->IsObject()) throw CadError("INVALID_MATERIAL_PROPERTY", "customProperties must be an object.");
    for (const auto& [key, value] : custom->AsObject())
      record.CustomProperties[key] = parseMaterialProperty(value, myVariables);
  }
  myMaterials.Set(record);
  ++myRevision;
  persistMetadata();
  return Summary(requestId);
}

std::string CadDocument::SetMaterialProperty(const std::string& requestId, const int expectedRevision,
                                             const JsonValue& parameters)
{
  if (expectedRevision != myRevision) throw CadError("STALE_REVISION", "Document revision is stale. Reload before editing material properties.");
  const std::string materialName = parameters.GetString("materialName");
  const std::string key = parameters.GetString("key");
  myMaterials.SetProperty(materialName, key, parseMaterialProperty(parameters, myVariables));
  ++myRevision;
  persistMetadata();
  return Summary(requestId);
}

std::string CadDocument::DeleteMaterialProperty(const std::string& requestId, const int expectedRevision,
                                                const JsonValue& parameters)
{
  if (expectedRevision != myRevision) throw CadError("STALE_REVISION", "Document revision is stale. Reload before deleting material properties.");
  myMaterials.DeleteProperty(parameters.GetString("materialName"), parameters.GetString("key"));
  ++myRevision;
  persistMetadata();
  return Summary(requestId);
}
std::string CadDocument::DeleteMaterial(const std::string& requestId, const int expectedRevision,
                                        const std::string& name)
{
  if (expectedRevision != myRevision) throw CadError("STALE_REVISION", "Document revision is stale. Reload before editing materials.");
  for (const auto& [id, body] : myBodies)
    if (body.Material == name)
      throw CadError("MATERIAL_IN_USE", "Material is assigned to Body " + id + ".");
  myMaterials.Delete(name);
  ++myRevision;
  persistMetadata();
  return Summary(requestId);
}
std::string CadDocument::UpdateBody(const std::string& requestId, const int expectedRevision,
                                    const std::string& bodyId, const JsonValue& parameters)
{
  if (expectedRevision != myRevision) throw CadError("STALE_REVISION", "Document revision is stale. Reload before editing the body.");
  BodyRecord& live = bodyOrActive(bodyId);
  BodyRecord body = live;
  if (const JsonValue* name = parameters.Find("name"))
  {
    if (!name->IsString() || name->AsString().empty() || name->AsString().size() > 128)
      throw CadError("INVALID_BODY_NAME", "Body name must contain 1-128 characters.");
    body.Name = name->AsString();
  }
  if (const JsonValue* visible = parameters.Find("visible")) body.Visible = visible->AsBoolean();
  if (const JsonValue* color = parameters.Find("color"))
  {
    if (!color->IsString() || !validColor(color->AsString())) throw CadError("INVALID_BODY_COLOR", "Body color must use #RRGGBB format.");
    body.Color = color->AsString();
  }
  if (const JsonValue* opacity = parameters.Find("opacity"))
  {
    if (!opacity->IsNumber())
      throw CadError("INVALID_BODY_OPACITY", "Body opacity must be between 0.05 and 1.0.");
    body.Opacity = ValidatedBodyOpacity(opacity->AsNumber());
  }
  if (const JsonValue* material = parameters.Find("material"))
  {
    if (!material->IsString() || material->AsString().size() > 128) throw CadError("INVALID_BODY_MATERIAL", "Body material name is too long.");
    body.Material = material->AsString();
  }
  const auto sourceFeature = std::find_if(myFeatures.begin(), myFeatures.end(), [&](const FeatureNode& feature) { return feature.Id == body.SourceFeatureId; });
  const bool activate=parameters.GetBooleanOr("activate",false);
  if (sourceFeature != myFeatures.end())
  {
    StoreBodyDisplayMetadata(*sourceFeature,"outputBodyMeta",body);
  }
  if (activate) myActiveBodyId = body.Id;
  live=std::move(body);
  ++myRevision;
  persistMetadata();
  return View(requestId);
}
}
