#include "protocol/Json.hxx"
#include "runtime/NativeResourceGuard.hxx"
#include "MeshQuality.hxx"
#include "MeshProvenance.hxx"
#include "MeshSizing.hxx"
#include "MeshOptimization.hxx"
#include "MeshWireStore.hxx"
#include "discrete/DiscreteVolumeWorker.hxx"

#include <gmsh.h>

#include <algorithm>
#include <cctype>
#include <cmath>
#include <filesystem>
#include <cstdio>
#include <iostream>
#include <iomanip>
#include <limits>
#include <sstream>
#include <set>
#include <map>
#include <stdexcept>
#include <string>
#include <vector>
#include <array>
#include <unordered_map>
#include <memory>
#include <array>
#include <unordered_map>
#ifdef _WIN32
#include <io.h>
#else
#include <unistd.h>
#endif

namespace
{
using occweb::JsonEscape;
using occweb::JsonParser;
using occweb::JsonValue;

const JsonValue& parametersOrEmpty(const JsonValue& request)
{
  static const JsonValue empty = JsonValue::MakeObject();
  const JsonValue* parameters = request.Find("parameters");
  return parameters == nullptr ? empty : *parameters;
}

std::string errorJson(const std::string& requestId, const std::string& code, const std::string& message)
{
  return "{\"ok\":false,\"protocolVersion\":1,\"requestId\":\""
       + JsonEscape(requestId) + "\",\"code\":\"" + JsonEscape(code)
       + "\",\"error\":\"" + JsonEscape(message) + "\"}";
}

void requireRegularFile(const std::string& inputPath)
{
  if (inputPath.empty()) throw std::runtime_error("parameters.inputPath is required.");
  std::error_code error;
  const std::filesystem::path path = std::filesystem::weakly_canonical(inputPath, error);
  if (error || !std::filesystem::is_regular_file(path))
    throw std::runtime_error("Input geometry file does not exist: " + inputPath);
}

void prepareOutputPath(const std::string& outputPath)
{
  if (outputPath.empty()) throw std::runtime_error("parameters.outputPath is required.");
  const std::filesystem::path path(outputPath);
  if (path.has_parent_path())
  {
    std::error_code error;
    std::filesystem::create_directories(path.parent_path(), error);
    if (error) throw std::runtime_error("Could not create mesh output directory: " + error.message());
  }
}

std::string lowerExtension(const std::string& inputPath)
{
  std::string extension = std::filesystem::path(inputPath).extension().string();
  std::transform(extension.begin(), extension.end(), extension.begin(), [](unsigned char character) {
    return static_cast<char>(std::tolower(character));
  });
  return extension;
}

bool isOccFormat(const std::string& inputPath)
{
  const std::string extension = lowerExtension(inputPath);
  return extension == ".step" || extension == ".stp" || extension == ".iges" || extension == ".igs" || extension == ".brep";
}

class StdoutSilencer
{
public:
  StdoutSilencer()
  {
    std::cout.flush();
    std::fflush(stdout);
#ifdef _WIN32
    mySaved = _dup(_fileno(stdout));
    mySink = std::fopen("NUL", "w");
    if (mySaved >= 0 && mySink != nullptr) _dup2(_fileno(mySink), _fileno(stdout));
#else
    mySaved = dup(fileno(stdout));
    mySink = std::fopen("/dev/null", "w");
    if (mySaved >= 0 && mySink != nullptr) dup2(fileno(mySink), fileno(stdout));
#endif
  }

  ~StdoutSilencer()
  {
    std::fflush(stdout);
    if (mySaved >= 0)
    {
#ifdef _WIN32
      _dup2(mySaved, _fileno(stdout));
      _close(mySaved);
#else
      dup2(mySaved, fileno(stdout));
      close(mySaved);
#endif
    }
    if (mySink != nullptr) std::fclose(mySink);
  }

private:
  int mySaved = -1;
  FILE* mySink = nullptr;
};

void writeModelFile(const std::string& outputPath)
{
  StdoutSilencer silencer;
  gmsh::write(outputPath);
}
struct ModelStats
{
  std::size_t points = 0;
  std::size_t curves = 0;
  std::size_t surfaces = 0;
  std::size_t volumes = 0;
  std::size_t duplicateNodes = 0;
};

ModelStats collectModelStats(bool includeDuplicateNodes)
{
  ModelStats stats;
  std::vector<std::pair<int, int>> entities;
  gmsh::model::getEntities(entities);
  for (const auto& entity : entities)
  {
    if (entity.first == 0) ++stats.points;
    else if (entity.first == 1) ++stats.curves;
    else if (entity.first == 2) ++stats.surfaces;
    else if (entity.first == 3) ++stats.volumes;
  }
  if (includeDuplicateNodes)
  {
    std::vector<std::size_t> duplicateTags;
    gmsh::model::mesh::getDuplicateNodes(duplicateTags);
    stats.duplicateNodes = duplicateTags.size();
  }
  return stats;
}

std::string modelStatsJson(const ModelStats& stats)
{
  std::ostringstream result;
  result << "\"pointCount\":" << stats.points
         << ",\"curveCount\":" << stats.curves
         << ",\"surfaceCount\":" << stats.surfaces
         << ",\"volumeCount\":" << stats.volumes
         << ",\"duplicateNodeCount\":" << stats.duplicateNodes;
  return result.str();
}

struct PreparationReport
{
  std::string mode;
  bool cadHealing = false;
  bool duplicateCleanup = false;
  bool surfaceClassification = false;
  bool intersectionResolution = false;
  std::vector<std::string> warnings;
};

void addWarning(PreparationReport& report, const std::string& warning)
{
  report.warnings.push_back(warning);
}

PreparationReport prepareModel(const JsonValue& parameters, const std::string& inputPath, bool allowRepair)
{
  PreparationReport report;
  report.mode = parameters.GetStringOr("repairMode", "strict");
  if (report.mode != "strict" && report.mode != "conservative" && report.mode != "aggressive")
    throw std::runtime_error("parameters.repairMode must be strict, conservative or aggressive.");
  const bool resolveIntersections = parameters.GetBooleanOr("resolveIntersections", false);
  const double surfaceAngle = parameters.GetNumberOr("surfaceAngle", 40.0) * M_PI / 180.0;

  gmsh::clear();
  gmsh::open(inputPath);
  gmsh::option::setNumber("General.Terminal", 0);
  gmsh::option::setNumber("General.Verbosity", 0);

  if (isOccFormat(inputPath))
  {
    if (allowRepair && report.mode != "strict")
    {
      const ModelStats beforeHealing = collectModelStats(false);
      gmsh::vectorpair healed;
      const bool aggressive = report.mode == "aggressive";
      const double tolerance = parameters.GetNumberOr("tolerance", aggressive ? 1e-6 : 1e-8);
      gmsh::model::occ::healShapes(healed, gmsh::vectorpair(), tolerance,
                                   true, aggressive, aggressive, true, true);
      gmsh::model::occ::synchronize();
      report.cadHealing = true;

      // healShapes can unwrap a STEP assembly containing several overlapping
      // solids into surfaces only. Keep the single conformal mesh workflow
      // usable by restoring the original closed OCC solids in that case.
      const ModelStats afterHealing = collectModelStats(false);
      if (beforeHealing.volumes > 0 && afterHealing.volumes == 0)
      {
        gmsh::clear();
        gmsh::open(inputPath);
        gmsh::option::setNumber("General.Terminal", 0);
        gmsh::option::setNumber("General.Verbosity", 0);
        addWarning(report, "CAD healing removed all closed volumes; reverted to the original OCC solids for meshing.");
      }
    }
    if (resolveIntersections)
    {
      gmsh::model::occ::removeAllDuplicates();
      gmsh::model::occ::synchronize();
      report.intersectionResolution = true;
    }
  }
  else
  {
    ModelStats stats = collectModelStats(false);
    if (stats.volumes == 0)
    {
      if (allowRepair && report.mode != "strict")
      {
        gmsh::model::mesh::classifySurfaces(surfaceAngle, true, false, M_PI, true);
        gmsh::model::mesh::createGeometry();
        gmsh::model::mesh::removeDuplicateNodes();
        gmsh::model::mesh::removeDuplicateElements();
        report.surfaceClassification = true;
        report.duplicateCleanup = true;
        if (resolveIntersections)
          addWarning(report, "离散表面已分类并去重；任意相交三角形需要后续三角网格重构，Gmsh 不会自动保证所有交叉都被拆分。");
      }
      else if (resolveIntersections)
      {
        addWarning(report, "当前输入没有 CAD 体拓扑，无法使用 OCC 布尔碎片化；仅能在离散网格修复阶段处理交叉。");
      }
    }
    else if (resolveIntersections)
    {
      addWarning(report, "检测到 CAD 体但输入格式不是标准 OCC 文件；请优先转换为 STEP/BREP 后执行交叉处理。");
    }
  }
  return report;
}

std::string warningsJson(const PreparationReport& report)
{
  std::ostringstream result;
  result << "[";
  for (std::size_t index = 0; index < report.warnings.size(); ++index)
  {
    if (index > 0) result << ',';
    result << "\"" << JsonEscape(report.warnings[index]) << "\"";
  }
  result << "]";
  return result.str();
}

struct BodySpatialHint
{
  std::string bodyId;
  double volume = 0.0;
  std::array<double, 3> centroid{0.0, 0.0, 0.0};
  double diagonal = 1.0;
};

std::vector<BodySpatialHint> parseBodySpatialHints(const JsonValue& parameters)
{
  std::vector<BodySpatialHint> hints;
  const JsonValue* values = parameters.Find("bodyGeometry");
  if (values == nullptr || !values->IsArray()) return hints;
  for (const JsonValue& value : values->AsArray())
  {
    if (!value.IsObject()) continue;
    const JsonValue* centroid = value.Find("centroid");
    if (!value.Has("bodyId") || !value.GetStringOr("bodyId", "").size() || centroid == nullptr || !centroid->IsArray() || centroid->AsArray().size() != 3)
      continue;
    BodySpatialHint hint;
    hint.bodyId = value.GetStringOr("bodyId", "");
    hint.volume = value.GetNumberOr("volume", 0.0);
    for (std::size_t index = 0; index < 3; ++index)
      hint.centroid[index] = centroid->AsArray()[index].IsNumber() ? centroid->AsArray()[index].AsNumber() : 0.0;
    if (const JsonValue* bounds = value.Find("bounds"); bounds != nullptr && bounds->IsObject())
    {
      const JsonValue* minimum = bounds->Find("min");
      const JsonValue* maximum = bounds->Find("max");
      if (minimum != nullptr && maximum != nullptr && minimum->IsArray() && maximum->IsArray() && minimum->AsArray().size() == 3 && maximum->AsArray().size() == 3)
      {
        double diagonalSquared = 0.0;
        for (std::size_t index = 0; index < 3; ++index)
        {
          const double delta = maximum->AsArray()[index].AsNumber() - minimum->AsArray()[index].AsNumber();
          diagonalSquared += delta * delta;
        }
        if (diagonalSquared > 1e-18) hint.diagonal = std::sqrt(diagonalSquared);
      }
    }
    hints.push_back(hint);
  }
  return hints;
}

struct SolidManifestHint
{
  std::string bodyId;
  int solidIndex = -1;
  double volume = 0.0;
  std::array<double, 3> centroid{0.0, 0.0, 0.0};
  double diagonal = 1.0;
};

std::vector<SolidManifestHint> parseSolidManifest(const JsonValue& parameters)
{
  std::vector<SolidManifestHint> hints;
  const JsonValue* manifest = parameters.Find("bodyManifest");
  if (manifest == nullptr || !manifest->IsObject()) return hints;
  const JsonValue* bodies = manifest->Find("bodies");
  if (bodies == nullptr || !bodies->IsArray()) return hints;
  for (const JsonValue& body : bodies->AsArray())
  {
    if (!body.IsObject()) continue;
    const std::string bodyId = body.GetStringOr("bodyId", "");
    const JsonValue* solids = body.Find("solids");
    if (bodyId.empty() || solids == nullptr || !solids->IsArray()) continue;
    for (const JsonValue& solid : solids->AsArray())
    {
      if (!solid.IsObject()) continue;
      const JsonValue* centroid = solid.Find("centroid");
      if (centroid == nullptr || !centroid->IsArray() || centroid->AsArray().size() != 3) continue;
      SolidManifestHint hint;
      hint.bodyId = bodyId;
      hint.solidIndex = solid.GetIntegerOr("solidIndex", -1);
      hint.volume = solid.GetNumberOr("volume", 0.0);
      for (std::size_t index = 0; index < 3; ++index)
        hint.centroid[index] = centroid->AsArray()[index].IsNumber() ? centroid->AsArray()[index].AsNumber() : 0.0;
      if (const JsonValue* bounds = solid.Find("bounds"); bounds != nullptr && bounds->IsObject())
      {
        const JsonValue* minimum = bounds->Find("min");
        const JsonValue* maximum = bounds->Find("max");
        if (minimum != nullptr && maximum != nullptr && minimum->IsArray() && maximum->IsArray() && minimum->AsArray().size() == 3 && maximum->AsArray().size() == 3)
        {
          double diagonalSquared = 0.0;
          for (std::size_t index = 0; index < 3; ++index)
          {
            const double delta = maximum->AsArray()[index].AsNumber() - minimum->AsArray()[index].AsNumber();
            diagonalSquared += delta * delta;
          }
          if (diagonalSquared > 1e-18) hint.diagonal = std::sqrt(diagonalSquared);
        }
      }
      hints.push_back(hint);
    }
  }
  std::sort(hints.begin(), hints.end(), [](const SolidManifestHint& left, const SolidManifestHint& right) { return left.solidIndex < right.solidIndex; });
  return hints;
}

struct OwnershipAssignment
{
  int volumeTag = 0;
  int solidIndex = -1;
  std::string bodyId;
  double confidence = 0.0;
};
using VolumeOwnershipMap = std::unordered_map<int, std::vector<OwnershipAssignment>>;

VolumeOwnershipMap prepareOwnedSolids(const JsonValue& parameters, PreparationReport& report)
{
  const auto hints = parseSolidManifest(parameters);
  gmsh::vectorpair volumes;
  gmsh::model::getEntities(volumes, 3);
  std::sort(volumes.begin(), volumes.end());
  if (hints.size() != volumes.size()) throw std::runtime_error("BREP solid index manifest does not match imported volumes; ownership was not guessed.");
  VolumeOwnershipMap owners;
  for (std::size_t index = 0; index < volumes.size(); ++index)
  {
    const auto& hint = hints[index];
    double mass = 0, x = 0, y = 0, z = 0;
    gmsh::model::occ::getMass(3, volumes[index].second, mass);
    gmsh::model::occ::getCenterOfMass(3, volumes[index].second, x, y, z);
    const double distance = std::sqrt((x-hint.centroid[0])*(x-hint.centroid[0]) + (y-hint.centroid[1])*(y-hint.centroid[1]) + (z-hint.centroid[2])*(z-hint.centroid[2]));
    if (hint.solidIndex != static_cast<int>(index) || distance > 1e-7 * std::max(hint.diagonal,1.0)
        || std::abs(std::abs(mass)-std::abs(hint.volume)) > 1e-7 * std::max(std::abs(hint.volume),1.0))
      throw std::runtime_error("BREP solid index verification failed; no nearest-volume fallback was used.");
    owners[volumes[index].second].push_back({volumes[index].second,hint.solidIndex,hint.bodyId,1.0});
  }
  report.mode = parameters.GetStringOr("repairMode", "conservative");
  if (report.mode == "strict") return owners;
  const bool aggressive = report.mode == "aggressive";
  const double tolerance = parameters.GetNumberOr("tolerance", aggressive ? 1e-6 : 1e-8);
  for (const auto& original : volumes)
  {
    const auto source = owners.at(original.second);
    gmsh::vectorpair beforeRepair;
    gmsh::model::getEntities(beforeRepair,3);
    std::set<int> otherVolumes;
    for(const auto& entity:beforeRepair)if(entity.second!=original.second)otherVolumes.insert(entity.second);
    gmsh::vectorpair healed;
    gmsh::model::occ::healShapes(healed, {original}, tolerance, true, aggressive, aggressive, true, true);
    gmsh::model::occ::synchronize();
    std::set<int> descendants;
    // Gmsh's healShapes return list can include unchanged entities from the
    // whole model. Existing volumes owned by another source are not descendants
    // of this source just because they appear in that list.
    for (const auto& entity : healed)
      if (entity.first == 3 && !otherVolumes.count(entity.second)) descendants.insert(entity.second);
    if (descendants.empty()) throw std::runtime_error("Per-solid repair lost its closed volume; no ownership fallback was used.");
    owners.erase(original.second);
    for (const int tag : descendants)
      for (auto assignment : source) { assignment.volumeTag=tag; owners[tag].push_back(assignment); }
  }
  report.cadHealing = true;
  return owners;
}

OwnershipAssignment sourceOwnershipForVolume(int volumeTag, std::size_t volumeIndex, const JsonValue& parameters,
                                             const std::vector<SolidManifestHint>& manifestHints,
                                             const std::vector<std::string>& bodyIds)
{
  OwnershipAssignment assignment;
  assignment.volumeTag = volumeTag;
  try
  {
    double actualVolume = 0.0;
    double centerX = 0.0, centerY = 0.0, centerZ = 0.0;
    gmsh::model::occ::getMass(3, volumeTag, actualVolume);
    gmsh::model::occ::getCenterOfMass(3, volumeTag, centerX, centerY, centerZ);
    if (!manifestHints.empty())
    {
      double bestScore = std::numeric_limits<double>::infinity();
      const SolidManifestHint* best = nullptr;
      for (const SolidManifestHint& hint : manifestHints)
      {
        const double dx = centerX - hint.centroid[0];
        const double dy = centerY - hint.centroid[1];
        const double dz = centerZ - hint.centroid[2];
        const double distanceScore = std::sqrt(dx * dx + dy * dy + dz * dz) / std::max(hint.diagonal, 1.0);
        const double volumeScale = std::max({std::abs(actualVolume), std::abs(hint.volume), 1e-12});
        const double volumeScore = std::abs(actualVolume - hint.volume) / volumeScale;
        const double score = distanceScore + volumeScore;
        if (score < bestScore)
        {
          bestScore = score;
          best = &hint;
        }
      }
      if (best != nullptr && bestScore <= 1.5)
      {
        assignment.solidIndex = best->solidIndex;
        assignment.bodyId = best->bodyId;
        assignment.confidence = 1.0 / (1.0 + bestScore);
        return assignment;
      }
    }
  }
  catch (const std::exception&)
  {
  }
  if (volumeIndex < bodyIds.size())
  {
    assignment.bodyId = bodyIds[volumeIndex];
    assignment.confidence = 0.0;
  }
  return assignment;
}

VolumeOwnershipMap fragmentIntersections(const JsonValue& parameters, const VolumeOwnershipMap* initialOwnership = nullptr)
{
  VolumeOwnershipMap ownership;
  if (!parameters.GetBooleanOr("resolveIntersections", false)) return ownership;
  gmsh::vectorpair sourceVolumes;
  gmsh::model::getEntities(sourceVolumes, 3);
  std::sort(sourceVolumes.begin(), sourceVolumes.end(), [](const auto& left, const auto& right) { return left.second < right.second; });
  if (sourceVolumes.size() < 2) return initialOwnership ? *initialOwnership : ownership;

  std::vector<std::string> bodyIds;
  if (const JsonValue* ids = parameters.Find("bodyIds"); ids != nullptr && ids->IsArray())
    for (const JsonValue& id : ids->AsArray()) if (id.IsString()) bodyIds.push_back(id.AsString());
  const std::vector<SolidManifestHint> manifestHints = parseSolidManifest(parameters);
  std::vector<std::vector<OwnershipAssignment>> sourceOwnership;
  sourceOwnership.reserve(sourceVolumes.size());
  for (std::size_t index = 0; index < sourceVolumes.size(); ++index)
    sourceOwnership.push_back(initialOwnership ? initialOwnership->at(sourceVolumes[index].second)
      : std::vector<OwnershipAssignment>{sourceOwnershipForVolume(sourceVolumes[index].second, index, parameters, manifestHints, bodyIds)});

  gmsh::vectorpair outputVolumes;
  std::vector<gmsh::vectorpair> outputMap;
  try
  {
    gmsh::model::occ::fragment(sourceVolumes, {}, outputVolumes, outputMap, -1.0, true, true);
    gmsh::model::occ::synchronize();
  }
  catch (const std::exception& error)
  {
    throw std::runtime_error(std::string("Gmsh OCC fragment failed: ") + error.what());
  }
  for (std::size_t index = 0; index < outputMap.size() && index < sourceOwnership.size(); ++index)
  {
    const auto& sources = sourceOwnership[index];
    for (const auto& mapped : outputMap[index])
    {
      if (mapped.first != 3) continue;
      const int outputTag = mapped.second;
      for (const auto& source : sources) {
        auto& destinations = ownership[outputTag];
        if (std::none_of(destinations.begin(),destinations.end(),[&](const auto& value){return value.bodyId==source.bodyId && value.solidIndex==source.solidIndex;}))
          destinations.push_back({outputTag,source.solidIndex,source.bodyId,source.confidence});
      }
    }
  }
  const bool hasVolumeOutput = std::any_of(outputVolumes.begin(), outputVolumes.end(), [](const auto& output) { return output.first == 3; });
  if (!hasVolumeOutput) { outputVolumes.clear(); gmsh::model::getEntities(outputVolumes, 3); }
  if (ownership.empty() && !outputVolumes.empty())
  {
    if (initialOwnership) throw std::runtime_error("Fragment did not return source history; ownership was not guessed.");
    std::vector<std::pair<int, int>> currentVolumes;
    for (const auto& output : outputVolumes) if (output.first == 3) currentVolumes.push_back(output);
    std::sort(currentVolumes.begin(), currentVolumes.end(), [](const auto& left, const auto& right) { return left.second < right.second; });
    for (std::size_t index = 0; index < currentVolumes.size(); ++index)
    {
      OwnershipAssignment assignment;
      assignment.volumeTag = currentVolumes[index].second;
      if (!manifestHints.empty())
      {
        double centerX = 0.0, centerY = 0.0, centerZ = 0.0;
        try { gmsh::model::occ::getCenterOfMass(3, assignment.volumeTag, centerX, centerY, centerZ); } catch (const std::exception&) {}
        double bestDistance = std::numeric_limits<double>::infinity();
        const SolidManifestHint* best = nullptr;
        for (const SolidManifestHint& hint : manifestHints)
        {
          const double dx = centerX - hint.centroid[0];
          const double dy = centerY - hint.centroid[1];
          const double dz = centerZ - hint.centroid[2];
          const double distance = std::sqrt(dx * dx + dy * dy + dz * dz) / std::max(hint.diagonal, 1.0);
          if (distance < bestDistance) { bestDistance = distance; best = &hint; }
        }
        if (best != nullptr)
        {
          assignment.solidIndex = best->solidIndex;
          assignment.bodyId = best->bodyId;
          assignment.confidence = 0.0;
        }
      }
      if (assignment.bodyId.empty() && index < bodyIds.size()) assignment.bodyId = bodyIds[index];
      ownership[assignment.volumeTag] = {assignment};
    }
  }  for (const auto& output : outputVolumes)
    if (output.first == 3 && ownership.find(output.second) == ownership.end())
    {
      if (initialOwnership) throw std::runtime_error("Fragment produced a volume without source history.");
      ownership[output.second] = {OwnershipAssignment{output.second, -1, "", 0.0}};
    }
  return ownership;
}

std::string renderJson(int dimension, const JsonValue& parameters, const VolumeOwnershipMap* fragmentOwnership = nullptr, const occweb::PreparedMeshMapping* provenance = nullptr)
{
  const std::string wirePath=parameters.GetStringOr("renderOutputPath","");
  std::unique_ptr<MeshWireStore> wireStore;
  if(dimension==3&&!wirePath.empty()){prepareOutputPath(wirePath);wireStore=std::make_unique<MeshWireStore>(wirePath);}
  std::map<int,std::size_t> preparedIndices;
  if(provenance)for(std::size_t i=0;i<provenance->VolumeTags.size();++i)preparedIndices.emplace(provenance->VolumeTags[i],i);
  std::vector<std::size_t> nodeTags;
  std::vector<double> coordinates;
  std::vector<double> parametricCoordinates;
  gmsh::model::mesh::getNodes(nodeTags, coordinates, parametricCoordinates);
  std::unordered_map<std::size_t, std::array<double, 3>> points;
  std::unordered_map<std::size_t, std::size_t> nodeIndex;
  for (std::size_t index = 0; index < nodeTags.size(); ++index)
  {
    points[nodeTags[index]] = {coordinates[index * 3], coordinates[index * 3 + 1], coordinates[index * 3 + 2]};
    nodeIndex[nodeTags[index]] = index;
  }

  std::vector<std::string> bodyIds;
  if (const JsonValue* ids = parameters.Find("bodyIds"); ids != nullptr && ids->IsArray())
    for (const JsonValue& id : ids->AsArray())
      if (id.IsString()) bodyIds.push_back(id.AsString());

  const std::vector<BodySpatialHint> spatialHints = parseBodySpatialHints(parameters);
  const std::vector<SolidManifestHint> manifestHints = parseSolidManifest(parameters);
  std::vector<OwnershipAssignment> ownershipAssignments;
  std::set<std::string> assignedBodyIds;
  std::vector<int> unassignedVolumeTags;
  const bool spatialOwnershipAvailable = !spatialHints.empty();
  const bool solidIndexOwnershipAvailable = !manifestHints.empty();
  const std::vector<std::pair<int, int>> tetraEdges = {{0, 1}, {0, 2}, {0, 3}, {1, 2}, {1, 3}, {2, 3}};
  const std::vector<std::pair<int, int>> triangleEdges = {{0, 1}, {1, 2}, {2, 0}};
  const auto appendWire = [&](const std::vector<std::size_t>& nodes, const std::size_t stride,
                              const std::vector<std::pair<int, int>>& edges, std::ostringstream& output,
                              bool& first) {
    if (stride == 0) return;
    const std::size_t elementCount = nodes.size() / stride;
    for (std::size_t element = 0; element < elementCount; ++element)
      for (const auto& edge : edges)
        for (const int endpoint : {edge.first, edge.second})
        {
          if (static_cast<std::size_t>(endpoint) >= stride) continue;
          const auto point = points[nodes[element * stride + static_cast<std::size_t>(endpoint)]];
          for (double coordinate : point) { if (!first) output << ','; first = false; output << coordinate; }
        }
  };
  const auto elementsWire = [&](const int dimensionTag, const int entityTag,
                                const std::vector<std::pair<int, int>>& edges) {
    std::vector<int> types;
    std::vector<std::vector<std::size_t>> tags;
    std::vector<std::vector<std::size_t>> nodes;
    gmsh::model::mesh::getElements(types, tags, nodes, dimensionTag, entityTag);
    std::ostringstream output;
    bool first = true;
    for (std::size_t index = 0; index < types.size(); ++index)
    {
      if (dimensionTag == 3 && types[index] != 4 && types[index] != 11) continue;
      if (dimensionTag == 2 && types[index] != 2 && types[index] != 9) continue;
      const std::size_t stride = tags[index].empty() ? 0 : nodes[index].size() / tags[index].size();
      appendWire(nodes[index], stride, edges, output, first);
    }
    return output.str();
  };

  std::ostringstream result;
  result << std::setprecision(12) << R"({"dimension":)" << dimension << R"(,"positions":[)";
  if(!wireStore)for (std::size_t index = 0; index < coordinates.size(); ++index) { if (index > 0) result << ','; result << coordinates[index]; }
  result << ']';
  if (dimension == 2)
  {
    std::vector<std::size_t> tags, nodes;
    gmsh::model::mesh::getElementsByType(2, tags, nodes);
    if (tags.empty()) gmsh::model::mesh::getElementsByType(9, tags, nodes);
    result << R"(,"kind":"surface","indices":[)";
    const std::size_t stride = tags.empty() ? 0 : nodes.size() / tags.size();
    for (std::size_t index = 0; index < tags.size(); ++index)
    {
      if (index > 0) result << ',';
      result << nodeIndex[nodes[index * stride]] << ',' << nodeIndex[nodes[index * stride + 1]] << ',' << nodeIndex[nodes[index * stride + 2]];
    }
    result << ']';
  }
  else
  {
    std::vector<std::size_t> tags, nodes;
    gmsh::model::mesh::getElementsByType(4, tags, nodes);
    if (tags.empty()) gmsh::model::mesh::getElementsByType(11, tags, nodes);
    result << R"(,"kind":"wire","wirePositions":[)";
    const std::size_t stride = tags.empty() ? 0 : nodes.size() / tags.size();
    bool first = true;
    if(!wireStore)appendWire(nodes, stride, tetraEdges, result, first);
    result << ']';

    gmsh::vectorpair volumeEntities;
    gmsh::model::getEntities(volumeEntities, 3);
    std::sort(volumeEntities.begin(), volumeEntities.end(), [](const auto& left, const auto& right) { return left.second < right.second; });
    result << R"(,"groups":[)";
    bool firstGroup = true;
    for (std::size_t volumeIndex = 0; volumeIndex < volumeEntities.size(); ++volumeIndex)
    {
      const int volumeTag = volumeEntities[volumeIndex].second;
      std::string bodyId;
      int assignedSolidIndex = -1;
      double ownershipConfidence = 0.0;
      if (fragmentOwnership != nullptr)
      {
        const auto mapped = fragmentOwnership->find(volumeTag);
        if (mapped != fragmentOwnership->end() && !mapped->second.empty())
        {
          bodyId = mapped->second.front().bodyId;
          assignedSolidIndex = mapped->second.front().solidIndex;
          ownershipConfidence = mapped->second.front().confidence;
        }
      }
      if (bodyId.empty() && solidIndexOwnershipAvailable && volumeIndex < manifestHints.size())
      {
        const SolidManifestHint& hint = manifestHints[volumeIndex];
        try
        {
          double actualVolume = 0.0;
          double centerX = 0.0, centerY = 0.0, centerZ = 0.0;
          gmsh::model::occ::getMass(3, volumeTag, actualVolume);
          gmsh::model::occ::getCenterOfMass(3, volumeTag, centerX, centerY, centerZ);
          const double dx = centerX - hint.centroid[0];
          const double dy = centerY - hint.centroid[1];
          const double dz = centerZ - hint.centroid[2];
          const double distanceScore = std::sqrt(dx * dx + dy * dy + dz * dz) / std::max(hint.diagonal, 1.0);
          const double volumeScale = std::max({std::abs(actualVolume), std::abs(hint.volume), 1e-12});
          const double volumeScore = std::abs(actualVolume - hint.volume) / volumeScale;
          const double score = distanceScore + volumeScore;
          if (score <= 1.5)
          {
            bodyId = hint.bodyId;
            assignedSolidIndex = hint.solidIndex;
            ownershipConfidence = 1.0 / (1.0 + score);
          }
        }
        catch (const std::exception&)
        {
          bodyId.clear();
        }
      }
      if (bodyId.empty() && spatialOwnershipAvailable)
      {
        try
        {
          double actualVolume = 0.0;
          double centerX = 0.0, centerY = 0.0, centerZ = 0.0;
          gmsh::model::occ::getMass(3, volumeTag, actualVolume);
          gmsh::model::occ::getCenterOfMass(3, volumeTag, centerX, centerY, centerZ);
          double bestScore = std::numeric_limits<double>::infinity();
          for (const BodySpatialHint& hint : spatialHints)
          {
            const double dx = centerX - hint.centroid[0];
            const double dy = centerY - hint.centroid[1];
            const double dz = centerZ - hint.centroid[2];
            const double distanceScore = std::sqrt(dx * dx + dy * dy + dz * dz) / std::max(hint.diagonal, 1.0);
            const double volumeScale = std::max({std::abs(actualVolume), std::abs(hint.volume), 1e-12});
            const double volumeScore = std::abs(actualVolume - hint.volume) / volumeScale;
            const double score = distanceScore + volumeScore;
            if (score < bestScore)
            {
              bestScore = score;
              bodyId = hint.bodyId;
            }
          }
          if (!bodyId.empty()) ownershipConfidence = 1.0 / (1.0 + bestScore);
        }
        catch (const std::exception&)
        {
          bodyId.clear();
        }
      }
      if (bodyId.empty() && volumeIndex < bodyIds.size())
      {
        bodyId = bodyIds[volumeIndex];
        ownershipConfidence = (solidIndexOwnershipAvailable || spatialOwnershipAvailable) ? 0.0 : 0.5;
      }
      if (bodyId.empty())
      {
        bodyId = "unassigned-volume-" + std::to_string(volumeTag);
        unassignedVolumeTags.push_back(volumeTag);
      }
      auto owners = std::vector<OwnershipAssignment>{{volumeTag,assignedSolidIndex,bodyId,ownershipConfidence}};
      if (fragmentOwnership && fragmentOwnership->count(volumeTag) && !fragmentOwnership->at(volumeTag).empty()) owners=fragmentOwnership->at(volumeTag);
      for (const auto& owner : owners) {
      bodyId=owner.bodyId;assignedSolidIndex=owner.solidIndex;ownershipConfidence=owner.confidence;
      assignedBodyIds.insert(bodyId);
      ownershipAssignments.push_back({volumeTag, assignedSolidIndex, bodyId, ownershipConfidence});
      const std::string solidId = "solid-" + std::to_string(volumeTag);
      const std::string groupId = solidId + "/owner/" + bodyId;
      double fragmentVolume = 0.0;
      gmsh::model::occ::getMass(3, volumeTag, fragmentVolume);
      if (!firstGroup) result << ',';
      firstGroup = false;
      result << R"({"groupId":")" << JsonEscape(groupId) << R"(","kind":"solid","bodyId":")"
             << JsonEscape(bodyId) << "\",\"solidIndex\":" << assignedSolidIndex << ",\"solidId\":\""
             << JsonEscape(solidId) << "\",\"volume\":" << fragmentVolume << R"(,"wirePositions":[)"
             << (wireStore?std::string():elementsWire(3, volumeTag, tetraEdges)) << ']';
      if(wireStore)result<<",\"wireKey\":\""<<wireStore->Write(3,volumeTag,points)<<'"';
      result<<R"(,"faces":[)";
      gmsh::vectorpair boundary;
      gmsh::model::getBoundary({{3, volumeTag}}, boundary, true, false, false);
      std::set<int> surfaceTags;
      for (const auto& item : boundary) if (item.first == 2) surfaceTags.insert(std::abs(item.second));
      bool firstFace = true;
      for (const int surfaceTag : surfaceTags)
      {
        const std::string faceId = "face-" + std::to_string(surfaceTag);
        if (!firstFace) result << ',';
        firstFace = false;
        result << R"({"groupId":")" << JsonEscape(groupId + "/" + faceId) << R"(","kind":"face","bodyId":")"
               << JsonEscape(bodyId) << "\",\"solidIndex\":" << assignedSolidIndex << ",\"solidId\":\""
               << JsonEscape(solidId) << R"(","faceId":")"
               << JsonEscape(faceId) << '"';
        if(provenance)result<<",\"meshFaceId\":\"mesh-face-"<<surfaceTag<<"\",\"cadSources\":"<<occweb::PreparedSurfaceSourcesJson(*provenance,surfaceTag);
        result<<R"(,"wirePositions":[)" << (wireStore?std::string():elementsWire(2, surfaceTag, triangleEdges)) << ']';
        if(wireStore)result<<",\"wireKey\":\""<<wireStore->Write(2,surfaceTag,points)<<'"';
        result<<'}';
      }
      result << "]}";
      }
    }
    if(provenance){
      std::set<std::pair<std::string,int>> sheets;
      for(const auto& [tag,sources]:provenance->SurfaceSources)for(const auto& source:sources.AsArray()){
        const std::string bodyId=source.GetString("bodyId");bool sheet=false;
        for(const auto& body:provenance->Manifest.At("bodies").AsArray())if(body.GetString("bodyId")==bodyId)sheet=body.GetString("kind")=="sheet";
        if(!sheet||!sheets.emplace(bodyId,tag).second)continue;
        if(!firstGroup)result<<',';firstGroup=false;
        result<<"{\"groupId\":\"sheet/"<<JsonEscape(bodyId)<<"/mesh-face-"<<tag<<"\",\"kind\":\"face\",\"sourceBodySurface\":true,\"bodyId\":\""<<JsonEscape(bodyId)<<"\",\"faceId\":\"face-"<<tag<<"\",\"meshFaceId\":\"mesh-face-"<<tag<<"\",\"cadSources\":"<<occweb::PreparedSurfaceSourcesJson(*provenance,tag)<<",\"wirePositions\":["<<(wireStore?std::string():elementsWire(2,tag,triangleEdges))<<']';
        if(wireStore)result<<",\"wireKey\":\""<<wireStore->Write(2,tag,points)<<'"';
        result<<'}';
      }
    }
    result << ']';
    result << R"(,"ownership":{"mode":")";
    const bool hasFallback = std::any_of(ownershipAssignments.begin(), ownershipAssignments.end(), [](const OwnershipAssignment& assignment) { return assignment.confidence <= 0.0; });
    const bool fragmentOwnershipAvailable = fragmentOwnership != nullptr && (!fragmentOwnership->empty() || ownershipAssignments.size() > 1)
      && (!solidIndexOwnershipAvailable || manifestHints.size() > 1);
    const std::string ownershipMode = provenance ? "occt-history-index" : fragmentOwnershipAvailable
      ? (hasFallback ? "fragment-map-with-fallback" : "fragment-map")
      : (solidIndexOwnershipAvailable
        ? (hasFallback ? "solid-index-with-fallback" : "solid-index")
        : (spatialOwnershipAvailable ? (hasFallback ? "spatial-with-fallback" : "spatial") : "order-fallback"));
    result << ownershipMode << R"(","unmappedBodyIds":[)";
    bool firstUnmapped = true;
    for (const std::string& bodyId : bodyIds)
    {
      if (assignedBodyIds.find(bodyId) != assignedBodyIds.end()) continue;
      if (!firstUnmapped) result << ',';
      firstUnmapped = false;
      result << '"' << JsonEscape(bodyId) << '"';
    }
    result << R"(],"unassignedVolumeTags":[)";
    for (std::size_t index = 0; index < unassignedVolumeTags.size(); ++index)
    {
      if (index > 0) result << ',';
      result << unassignedVolumeTags[index];
    }
    result << R"(],"assignments":[)";
    for (std::size_t index = 0; index < ownershipAssignments.size(); ++index)
    {
      if (index > 0) result << ',';
      const OwnershipAssignment& assignment = ownershipAssignments[index];
      result << R"({"volumeTag":)" << assignment.volumeTag << R"(,"solidIndex":)" << assignment.solidIndex
             << R"(,"bodyId":")" << JsonEscape(assignment.bodyId)
             << R"(","confidence":)" << assignment.confidence;
      // solidIndex is the original per-Body source Solid index, not the
      // prepared compound index. Keep the two namespaces explicitly separate.
      if(provenance){
        const auto found=preparedIndices.find(assignment.volumeTag);
        if(found==preparedIndices.end())throw std::runtime_error("Mesh volume is absent from the certified prepared inventory.");
        result << R"(,"preparedSolidIndex":)" << found->second;
      }
      result << '}';
    }
    result << R"(]})";
  }
  if(wireStore)result<<','<<wireStore->Manifest();
  result << '}';
  return result.str();
}
std::string conformityJson(const VolumeOwnershipMap& ownership)
{
  gmsh::vectorpair surfaces;
  gmsh::model::getEntities(surfaces, 2);
  std::map<int,std::set<int>> embeddedVolumes;
  gmsh::vectorpair volumes;gmsh::model::getEntities(volumes,3);
  for(const auto& volume:volumes){gmsh::vectorpair embedded;gmsh::model::mesh::getEmbedded(3,volume.second,embedded);for(const auto& entity:embedded)if(entity.first==2)embeddedVolumes[entity.second].insert(volume.second);}
  std::map<int,std::set<std::size_t>> volumeNodes;
  std::ostringstream entries;
  int count=0, invalid=0, embeddedCount=0;
  for (const auto& surface : surfaces) {
    std::vector<int> upward, downward;
    gmsh::model::getAdjacencies(2,surface.second,upward,downward);
    const auto embedded=embeddedVolumes.find(surface.second);
    if(embedded!=embeddedVolumes.end()){for(int volume:embedded->second)if(std::find(upward.begin(),upward.end(),volume)==upward.end())upward.push_back(volume);++embeddedCount;}
    if (upward.size()<2&&embedded==embeddedVolumes.end()) continue;
    std::set<std::string> bodyIds;
    for (const int volume : upward) {
      const auto owners=ownership.find(volume);
      if (owners!=ownership.end()) for (const auto& owner : owners->second) bodyIds.insert(owner.bodyId);
      if (!volumeNodes.count(volume)) {
        std::vector<int> types;
        std::vector<std::vector<std::size_t>> elements,nodes;
        gmsh::model::mesh::getElements(types,elements,nodes,3,volume);
        for (const auto& block : nodes) volumeNodes[volume].insert(block.begin(),block.end());
      }
    }
    std::vector<std::size_t> tags;
    std::vector<double> coordinates,parametric;
    gmsh::model::mesh::getNodes(tags,coordinates,parametric,2,surface.second,true);
    std::set<std::size_t> unique(tags.begin(),tags.end());
    std::size_t missing=0;
    for (const auto node : unique) for (const int volume : upward) if (!volumeNodes[volume].count(node)) ++missing;
    if (missing || unique.empty()) ++invalid;
    if (count++) entries << ',';
    entries << "{\"surfaceTag\":" << surface.second << ",\"role\":\""<<(embedded==embeddedVolumes.end()?"interface":"embedded")<<"\",\"nodeCount\":" << unique.size() << ",\"missingNodeReferences\":" << missing << ",\"bodyIds\":[";
    bool first=true;for(const auto& id:bodyIds){if(!first)entries<<',';first=false;entries<<'"'<<JsonEscape(id)<<'"';}
    entries << "],\"volumeTags\":[";
    for(std::size_t i=0;i<upward.size();++i){if(i)entries<<',';entries<<upward[i];}entries<<"]}";
  }
  return "{\"basis\":\"shared-node-tags\",\"interfaceCount\":"+std::to_string(count-embeddedCount)+",\"embeddedSurfaceCount\":"+std::to_string(embeddedCount)+",\"nonConformalCount\":"+std::to_string(invalid)+",\"interfaces\":["+entries.str()+"]}";
}

std::string repairModel(const std::string& requestId, const JsonValue& request, bool intersectionsOnly)
{
  const JsonValue& parameters = parametersOrEmpty(request);
  const std::string inputPath = parameters.GetStringOr("inputPath", "");
  const std::string outputPath = parameters.GetStringOr("outputPath", "");
  requireRegularFile(inputPath);
  prepareOutputPath(outputPath);
  JsonValue effective = parameters;
  if (intersectionsOnly) effective.ChangeObject()["repairMode"] = JsonValue(std::string("strict"));
  if (intersectionsOnly) effective.ChangeObject()["resolveIntersections"] = JsonValue(true);
  PreparationReport report = prepareModel(effective, inputPath, true);
  writeModelFile(outputPath);
  const ModelStats stats = collectModelStats(false);
  std::ostringstream result;
  result << "{\"ok\":true,\"protocolVersion\":1,\"requestId\":\"" << JsonEscape(requestId)
         << "\",\"service\":\"gmsh-mesh-worker\",\"repair\":{"
         << "\"inputPath\":\"" << JsonEscape(inputPath) << "\",\"outputPath\":\"" << JsonEscape(outputPath)
         << "\",\"mode\":\"" << JsonEscape(report.mode) << "\",\"cadHealing\":" << (report.cadHealing ? "true" : "false")
         << ",\"surfaceClassification\":" << (report.surfaceClassification ? "true" : "false")
         << ",\"duplicateCleanup\":" << (report.duplicateCleanup ? "true" : "false")
         << ",\"intersectionResolution\":" << (report.intersectionResolution ? "true" : "false")
         << ",\"warnings\":" << warningsJson(report) << ",\"geometry\":{" << modelStatsJson(stats) << "}}}";
  return result.str();
}

std::string createMesh(const std::string& requestId, const JsonValue& request)
{
  const JsonValue& parameters = parametersOrEmpty(request);
  const std::string inputPath = parameters.GetStringOr("inputPath", "");
  const std::string outputPath = parameters.GetStringOr("outputPath", "");
  const int dimension = parameters.GetIntegerOr("dimension", 3);
  if (dimension != 2 && dimension != 3) throw std::runtime_error("Only two-dimensional surface or three-dimensional tetrahedral meshing is supported.");
  requireRegularFile(inputPath);
  prepareOutputPath(outputPath);
  const bool ownedBrep = parameters.Find("bodyManifest") != nullptr;
  JsonValue preparation = parameters;
  if (ownedBrep) {
    preparation.ChangeObject()["repairMode"] = JsonValue(std::string("strict"));
    preparation.ChangeObject()["resolveIntersections"] = JsonValue(false);
  }
  const bool prepared=occweb::IsPreparedMesh(parameters);
  occweb::PreparedMeshMapping provenance;
  PreparationReport report;
  if(prepared){provenance=occweb::ImportPreparedMesh(inputPath,parameters.At("bodyManifest"));report.mode=parameters.GetStringOr("repairMode","conservative");report.cadHealing=report.mode!="strict";report.intersectionResolution=true;}
  else report=prepareModel(preparation, inputPath, true);
  VolumeOwnershipMap initialOwnership;
  if(prepared){for(const auto& [tag,sources]:provenance.VolumeSources){std::set<std::string> seen;for(const auto& source:sources)if(seen.insert(source.BodyId).second)initialOwnership[tag].push_back({tag,source.SourceSolidIndex,source.BodyId,1.0});}}
  else if (ownedBrep) initialOwnership = prepareOwnedSolids(parameters, report);
  const ModelStats geometry = collectModelStats(false);
  if (dimension == 3 && geometry.volumes == 0) throw std::runtime_error("No closed volume was found after repair; tetrahedral meshing requires a closed solid.");
  if (dimension == 2 && geometry.surfaces == 0) throw std::runtime_error("No surface was found after repair; surface meshing requires a face.");
  const VolumeOwnershipMap fragmentOwnership = prepared?initialOwnership:fragmentIntersections(parameters, ownedBrep ? &initialOwnership : nullptr);
  if (ownedBrep) {
    std::map<std::string,std::set<int>> bodyVolumes;
    for (const auto& [volume,owners] : fragmentOwnership)
      for (const auto& owner : owners) bodyVolumes[owner.bodyId].insert(volume);
    for (const auto& [body,tags] : bodyVolumes)
      gmsh::model::addPhysicalGroup(3,std::vector<int>(tags.begin(),tags.end()),-1,"Body/"+body);
    gmsh::option::setNumber("Mesh.SaveAll",1);
  }
  occweb::MeshSizingScope sizing(parameters,prepared?&provenance:nullptr);
  gmsh::model::mesh::generate(dimension);
  std::map<int,std::vector<std::string>> qualityOwners;
  for(const auto& [volume,owners]:fragmentOwnership)for(const auto& owner:owners)qualityOwners[volume].push_back(owner.bodyId);
  const std::string optimization=occweb::OptimizeMesh(parameters,qualityOwners);
  writeModelFile(outputPath);
  std::vector<std::size_t> nodeTags;
  std::vector<double> coordinates;
  std::vector<double> parametricCoordinates;
  gmsh::model::mesh::getNodes(nodeTags, coordinates, parametricCoordinates);
  std::vector<int> elementTypes;
  std::vector<std::vector<std::size_t>> elementTags;
  std::vector<std::vector<std::size_t>> elementNodeTags;
  gmsh::model::mesh::getElements(elementTypes, elementTags, elementNodeTags);
  std::size_t elementCount = 0;
  for (const auto& tags : elementTags) elementCount += tags.size();
  const QualityReport quality = analyzeQuality(parameters,qualityOwners);
  const std::string qualityPath=parameters.GetStringOr("qualityOutputPath","");
  if(!qualityPath.empty()){prepareOutputPath(qualityPath);writeQualityIndex(quality,qualityPath,requestId);}
  std::ostringstream result;
  result << "{\"ok\":true,\"protocolVersion\":1,\"requestId\":\"" << JsonEscape(requestId)
         << "\",\"service\":\"gmsh-mesh-worker\",\"mesh\":{";
  result << "\"inputPath\":\"" << JsonEscape(inputPath) << "\",\"outputPath\":\"" << JsonEscape(outputPath)
         << "\",\"dimension\":" << dimension << ",\"nodeCount\":" << nodeTags.size() << ",\"elementCount\":" << elementCount
         << ",\"repairMode\":\"" << JsonEscape(report.mode) << "\",\"warnings\":" << warningsJson(report)
         << ",\"quality\":{" << qualityJson(quality) << "},\"qualityDiagnostics\":" << (qualityPath.empty()?"false":"true") << ",\"conformity\":" << conformityJson(fragmentOwnership)
         << ",\"render\":" << renderJson(dimension, parameters, &fragmentOwnership,prepared?&provenance:nullptr);
  if(prepared)result<<",\"boundaryMapping\":"<<occweb::PreparedBoundaryJson(provenance);
  if(!sizing.Report().empty())result<<",\"sizing\":"<<sizing.Report();
  if(!optimization.empty())result<<",\"optimization\":"<<optimization;
  result << "}}";
  return result.str();
}
std::string preflight(const std::string& requestId, const JsonValue& request)
{
  const JsonValue& parameters = parametersOrEmpty(request);
  const std::string inputPath = parameters.GetStringOr("inputPath", "");
  requireRegularFile(inputPath);
  gmsh::clear();
  gmsh::open(inputPath);
  gmsh::option::setNumber("General.Terminal", 0);
  gmsh::option::setNumber("General.Verbosity", 0);
  const ModelStats stats = collectModelStats(true);
  std::ostringstream result;
  result << "{\"ok\":true,\"protocolVersion\":1,\"requestId\":\"" << JsonEscape(requestId)
         << "\",\"service\":\"gmsh-mesh-worker\",\"geometry\":{"
         << "\"inputPath\":\"" << JsonEscape(inputPath) << "\",\"format\":\"" << JsonEscape(lowerExtension(inputPath))
         << "\"," << modelStatsJson(stats) << ",\"hasVolume\":" << (stats.volumes > 0 ? "true" : "false") << "}}";
  return result.str();
}

std::string quality(const std::string& requestId, const JsonValue& request)
{
  const JsonValue& parameters = parametersOrEmpty(request);
  const std::string inputPath = parameters.GetStringOr("inputPath", "");
  requireRegularFile(inputPath);
  gmsh::clear();
  gmsh::open(inputPath);
  gmsh::option::setNumber("General.Terminal", 0);
  gmsh::option::setNumber("General.Verbosity", 0);
  verifyAsciiMeshElements(inputPath);
  const QualityReport report = analyzeQuality(parameters);
  const std::string qualityPath=parameters.GetStringOr("qualityOutputPath","");
  if(!qualityPath.empty()){prepareOutputPath(qualityPath);writeQualityIndex(report,qualityPath,requestId);}
  std::ostringstream result;
  result << "{\"ok\":true,\"protocolVersion\":1,\"requestId\":\"" << JsonEscape(requestId)
         << "\",\"service\":\"gmsh-mesh-worker\",\"quality\":{";
  result << "\"inputPath\":\"" << JsonEscape(inputPath) << "\"," << qualityJson(report)
         << ",\"warnings\":[" << (report.cells.empty() ? "\"no tetrahedral elements\"" : "") << "]}}";
  return result.str();
}
std::string dispatch(const JsonValue& request,const occweb::NativeResourceGuard& resourceGuard)
{
  if (!request.IsObject()) throw std::runtime_error("Request must be a JSON object.");
  if (request.GetIntegerOr("protocolVersion", 0) != 1) throw std::runtime_error("protocolVersion must be 1.");
  const std::string requestId = request.GetStringOr("requestId", "");
  const std::string operation = request.GetString("operation");
  if (operation == "health.ping")
  {
    std::error_code error;
    const std::string cwd = std::filesystem::current_path(error).string();
    return "{\"ok\":true,\"protocolVersion\":1,\"requestId\":\"" + JsonEscape(requestId)
         + "\",\"service\":\"gmsh-mesh-worker\",\"backend\":\"libgmsh\",\"cwd\":\""
         + JsonEscape(error ? std::string() : cwd) + "\",\"capabilities\":{\"version\":1,\"processResources\":"+resourceGuard.CapabilityJson()+"}}";
  }
  if (operation == "mesh.preflight") return preflight(requestId, request);
  if (operation == "mesh.create") return createMesh(requestId, request);
  if (operation == "mesh.repair") return repairModel(requestId, request, false);
  if (operation == "mesh.intersections") return repairModel(requestId, request, true);
  if (operation == "mesh.quality") return quality(requestId, request);
  throw std::runtime_error("Unknown mesh operation: " + operation);
}
}

int main(int argc,char** argv)
{
  if(argc==2&&std::string(argv[1])=="--discrete-single-job")return occweb::discrete::RunVolumeWorker();
  if(argc==2&&std::string(argv[1])=="--discrete-checkpoint-single-job")return occweb::discrete::RunVolumeWorker(true);
  if(argc!=1){std::cerr<<"Unsupported mesh worker arguments\n";return 2;}
  try {
  occweb::NativeResourceGuard resourceGuard(occweb::NativeResourceGuard::EnvironmentLimit("MESH_WORKER_MEMORY_LIMIT_BYTES"));
  std::ios::sync_with_stdio(false);
  std::cin.tie(nullptr);
  gmsh::initialize();
  gmsh::option::setNumber("General.Terminal", 0);
  gmsh::option::setNumber("General.Verbosity", 0);
  std::string line;
  while (std::getline(std::cin, line))
  {
    if (line.empty()) continue;
    std::string requestId;
    try
    {
      const occweb::JsonValue request = JsonParser(line).Parse();
      if (request.IsObject()) requestId = request.GetStringOr("requestId", "");
      std::cout << dispatch(request,resourceGuard) << '\n';
    }
    catch (const std::bad_alloc&) { occweb::NativeResourceGuard::AllocationFailure(); }
    catch (const occweb::MeshSizingError& error) { std::cout << errorJson(requestId, error.Code, error.what()) << '\n'; }
    catch (const occweb::JsonError& error) { std::cout << errorJson(requestId, "INVALID_JSON", error.what()) << '\n'; }
    catch (const std::exception& error) { std::cout << errorJson(requestId, "GMSH_FAILURE", error.what()) << '\n'; }
    std::cout.flush();
  }
  gmsh::finalize();
  return 0;
  }catch(const occweb::NativeResourceGuardError& error){std::cerr<<"Mesh resource guard unavailable: "<<error.what()<<'\n';return error.ExitCode();}
  catch(const std::bad_alloc&){occweb::NativeResourceGuard::AllocationFailure();}
  catch(const std::exception& error){std::cerr<<"Mesh startup failed: "<<error.what()<<'\n';return occweb::NativeResourceGuard::UnavailableExitCode;}
}
