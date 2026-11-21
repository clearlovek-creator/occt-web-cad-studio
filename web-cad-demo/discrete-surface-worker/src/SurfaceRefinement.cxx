// SPDX-License-Identifier: GPL-3.0-or-later
// Shared product core. CGAL 6.1.2 autorefinement uses its GPL-3.0-or-later option.
#include "protocol/Json.hxx"
#include "SurfaceRefinement.hxx"
#include <CGAL/Exact_predicates_exact_constructions_kernel.h>
#include <CGAL/Exact_predicates_inexact_constructions_kernel.h>
#include <CGAL/Polygon_mesh_processing/autorefinement.h>
#include <CGAL/Polygon_mesh_processing/self_intersections.h>
#include <CGAL/squared_distance_3.h>
#include <CGAL/version.h>
#include <algorithm>
#include <array>
#include <cmath>
#include <iostream>
#include <limits>
#include <map>
#include <memory>
#include <numeric>
#include <set>
#include <sstream>
#include <stdexcept>
#include <vector>

namespace
{
using occweb::JsonValue;
using EK                                = CGAL::Exact_predicates_exact_constructions_kernel;
using DK                                = CGAL::Exact_predicates_inexact_constructions_kernel;
namespace PMP                           = CGAL::Polygon_mesh_processing;
using Triangle                          = std::array<std::size_t, 3>;
using Owners                            = std::vector<std::size_t>;
constexpr std::size_t MaxInputTriangles = occweb::DiscreteSurfaceLimits::InputTriangles,
                      MaxOutputTriangles = occweb::DiscreteSurfaceLimits::OutputTriangles,
                      MaxPoints = occweb::DiscreteSurfaceLimits::Points,
                      MaxOwnerReferences = occweb::DiscreteSurfaceLimits::OwnerReferences;

struct Failure : std::runtime_error
{
  std::string Code;

  Failure(std::string code, std::string message)
      : std::runtime_error(message),
        Code(std::move(code))
  {
  }
};

void require(bool value, const std::string& code, const std::string& message)
{
  if (!value)
    throw Failure(code, message);
}

std::size_t index(const JsonValue& value, std::size_t count)
{
  const double n = value.AsNumber();
  require(std::isfinite(n) && n >= 0 && std::floor(n) == n && n < double(count),
          "INVALID_INPUT",
          "Triangle node index is invalid.");
  return std::size_t(n);
}

double finite(const JsonValue& value)
{
  const double v = value.AsNumber();
  require(std::isfinite(v) && std::abs(v) <= 1e12,
          "INVALID_INPUT",
          "Finite coordinates within 1e12 mm are required.");
  return v;
}

double area(const EK::Point_3& a, const EK::Point_3& b, const EK::Point_3& c)
{
  const double value = CGAL::to_double(CGAL::cross_product(b - a, c - a).squared_length());
  require(std::isfinite(value) && value >= 0,
          "UNSUPPORTED_SCALE",
          "Triangle area is outside supported numerical scale.");
  return .5 * std::sqrt(value);
}

JsonValue number(double value)
{
  require(std::isfinite(value), "INVALID_OUTPUT", "Non-finite output was rejected.");
  return JsonValue(value);
}

JsonValue integer(std::size_t value)
{
  return JsonValue(double(value));
}

struct VisitState
{
  std::size_t              Inputs  = 0;
  bool                     Emitted = false;
  std::vector<std::size_t> Source;
  std::set<std::size_t>    Deleted;
};

struct Visitor : PMP::Autorefinement::Default_visitor
{
  std::shared_ptr<VisitState> State;

  explicit Visitor(std::size_t count)
      : State(std::make_shared<VisitState>())
  {
    State->Inputs = count;
  }

  void number_of_output_triangles(std::size_t n)
  {
    require(n <= MaxOutputTriangles,
            "SURFACE_OUTPUT_LIMIT",
            "Refined triangle count exceeds the surface limit.");
    require(!State->Emitted, "SOURCE_MAP_INVALID", "Unexpected repeated final source callback.");
    State->Emitted = true;
    State->Source.assign(n, std::numeric_limits<std::size_t>::max());
  }

  void put(std::size_t target, std::size_t source)
  {
    require(State->Emitted && target < State->Source.size() && source < State->Inputs,
            "SOURCE_MAP_INVALID",
            "Autorefinement source callback is invalid.");
    auto& saved = State->Source[target];
    require(saved == std::numeric_limits<std::size_t>::max() || saved == source,
            "SOURCE_MAP_INVALID",
            "Conflicting source callbacks.");
    saved = source;
  }

  void new_subtriangle(std::size_t target, std::size_t source) { put(target, source); }

  void verbatim_triangle_copy(std::size_t target, std::size_t source) { put(target, source); }

  void delete_triangle(std::size_t source)
  {
    require(source < State->Inputs, "SOURCE_MAP_INVALID", "Deleted source is invalid.");
    State->Deleted.insert(source);
  }

  std::vector<Owners> owners(const std::vector<Owners>& input, std::size_t output) const
  {
    if (!State->Emitted)
    {
      require(output == input.size(), "SOURCE_MAP_INVALID", "Missing final source callbacks.");
      return input;
    }
    require(State->Source.size() == output, "SOURCE_MAP_INVALID", "Incomplete output source map.");
    std::vector<Owners> result;
    result.reserve(output);
    for (const auto source : State->Source)
    {
      require(source < input.size(), "SOURCE_MAP_INVALID", "An output triangle has no source.");
      result.push_back(input[source]);
    }
    return result;
  }
};

template <class Point>
void canonicalize(std::vector<Point>&    points,
                  std::vector<Triangle>& triangles,
                  std::vector<Owners>&   owners)
{
  require(points.size() <= MaxPoints && triangles.size() <= MaxOutputTriangles
            && owners.size() == triangles.size(),
          "SURFACE_OUTPUT_LIMIT",
          "Surface output exceeds the surface limit.");
  using Less = typename CGAL::Kernel_traits<Point>::Kernel::Less_xyz_3;
  std::map<Point, std::size_t, Less> unique;
  std::vector<Point>                 compact;
  std::vector<std::size_t>           remap(points.size());
  for (std::size_t i = 0; i < points.size(); ++i)
  {
    const auto inserted = unique.emplace(points[i], compact.size());
    if (inserted.second)
      compact.push_back(points[i]);
    remap[i] = inserted.first->second;
  }
  std::map<Triangle, std::size_t> faces;
  std::vector<Triangle>           merged;
  std::vector<Owners>             sources;
  std::size_t                     references = 0;
  for (std::size_t i = 0; i < triangles.size(); ++i)
  {
    auto triangle = triangles[i];
    for (auto& p : triangle)
    {
      require(p < remap.size(), "INVALID_OUTPUT", "Output node index is invalid.");
      p = remap[p];
    }
    auto key = triangle;
    std::sort(key.begin(), key.end());
    require(key[0] != key[1] && key[1] != key[2],
            "INVALID_OUTPUT",
            "Degenerate indexed output triangle.");
    const auto inserted = faces.emplace(key, merged.size());
    if (inserted.second)
    {
      merged.push_back(triangle);
      sources.emplace_back();
    }
    auto& group = sources[inserted.first->second];
    require(references + owners[i].size() <= MaxOwnerReferences,
            "SOURCE_MAP_LIMIT",
            "Source reference budget exceeded.");
    references += owners[i].size();
    group.insert(group.end(), owners[i].begin(), owners[i].end());
  }
  for (auto& group : sources)
  {
    std::sort(group.begin(), group.end());
    group.erase(std::unique(group.begin(), group.end()), group.end());
    require(!group.empty(), "SOURCE_MAP_INVALID", "Empty triangle ownership.");
  }
  points    = std::move(compact);
  triangles = std::move(merged);
  owners    = std::move(sources);
}

std::vector<Triangle> readTriangles(const JsonValue& value, std::size_t pointCount)
{
  require(value.IsArray() && !value.AsArray().empty()
            && value.AsArray().size() <= MaxInputTriangles,
          "SURFACE_INPUT_LIMIT",
          "Input requires 1 to 20000 triangles.");
  std::vector<Triangle> result;
  for (const auto& row : value.AsArray())
  {
    require(row.IsArray() && row.AsArray().size() == 3,
            "INVALID_INPUT",
            "Triangle must contain three node indices.");
    result.push_back({index(row.AsArray()[0], pointCount),
                      index(row.AsArray()[1], pointCount),
                      index(row.AsArray()[2], pointCount)});
  }
  return result;
}

JsonValue refine(const JsonValue& request)
{
  for(const auto& [name,unused]:request.AsObject())
    require(name=="units"||name=="points"||name=="triangles"||name=="sources"||name=="options",
            "INVALID_INPUT","Unknown surface input field.");
  require(request.GetStringOr("units", "") == "mm",
          "INVALID_INPUT",
          "Explicit mm units are required.");
  const auto& rows = request.At("points").AsArray();
  require(rows.size() >= 3 && rows.size() <= MaxPoints,
          "SURFACE_INPUT_LIMIT",
          "Point count exceeds surface limits.");
  std::vector<EK::Point_3> originalPoints;
  originalPoints.reserve(rows.size());
  for (const auto& row : rows)
  {
    require(row.IsArray() && row.AsArray().size() == 3,
            "INVALID_INPUT",
            "Point must contain three coordinates.");
    originalPoints.emplace_back(finite(row.AsArray()[0]),
                                finite(row.AsArray()[1]),
                                finite(row.AsArray()[2]));
  }
  const auto  originalTriangles = readTriangles(request.At("triangles"), originalPoints.size());
  const auto& sourceRecords     = request.At("sources").AsArray();
  require(sourceRecords.size() == originalTriangles.size(),
          "SOURCE_MAP_INVALID",
          "Every input triangle must provide a source record.");
  for (const auto& source : sourceRecords)
  {
    require(source.IsObject() && source.AsObject().size() <= 3,
            "SOURCE_MAP_INVALID",
            "Source records accept bodyId, faceId and optional solidId only.");
    for (const auto& [name, value] : source.AsObject())
    {
      require(name == "bodyId" || name == "faceId" || name == "solidId",
              "SOURCE_MAP_INVALID",
              "Unknown source record key.");
      require(value.IsString() && !value.AsString().empty() && value.AsString().size() <= 80,
              "SOURCE_MAP_INVALID",
              "Source identity is invalid.");
      require(value.AsString().find_first_not_of("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.:-")==std::string::npos,
              "SOURCE_MAP_INVALID","Source identities must use bounded ASCII identifier characters.");
    }
    require(source.Has("bodyId") && source.Has("faceId"),
            "SOURCE_MAP_INVALID",
            "Body and Face source identities are required.");
  }
  const auto options = request.Find("options");
  int        grid = 40, iterations = 5;
  double     tolerance = 1e-7;
  if (options)
  {
    require(options->IsObject(), "INVALID_INPUT", "Options must be an object.");
    for (const auto& [name, unused] : options->AsObject())
      require(name == "snapGridSize" || name == "iterations" || name == "tolerance",
              "INVALID_INPUT",
              "Unknown repair option.");
    grid       = options->GetIntegerOr("snapGridSize", 40);
    iterations = options->GetIntegerOr("iterations", 5);
    tolerance  = options->GetNumberOr("tolerance", 1e-7);
  }
  require(grid >= 30 && grid < 52 && iterations >= 1 && iterations <= 10 && std::isfinite(tolerance)
            && tolerance >= 1e-12 && tolerance <= 1e-3,
          "INVALID_INPUT",
          "Invalid snapping or geometric tolerance options.");
  auto                     exactPoints = originalPoints;
  std::vector<Triangle>    exactTriangles;
  std::vector<Owners>      exactOwners;
  std::vector<std::size_t> degenerate;
  for (std::size_t i = 0; i < originalTriangles.size(); ++i)
  {
    const auto& t = originalTriangles[i];
    if (CGAL::collinear(originalPoints[t[0]], originalPoints[t[1]], originalPoints[t[2]]))
    {
      degenerate.push_back(i);
      continue;
    }
    exactTriangles.push_back(t);
    exactOwners.push_back({i});
  }
  require(!exactTriangles.empty(),
          "NO_SURFACE",
          "All input triangles are degenerate; no repaired surface is available.");
  canonicalize(exactPoints, exactTriangles, exactOwners);
  const std::size_t distinctInputTriangles = exactTriangles.size();
  const bool inputCrossings = PMP::does_triangle_soup_self_intersect(exactPoints, exactTriangles);
  Visitor    exactVisitor(exactTriangles.size());
  PMP::autorefine_triangle_soup(
    exactPoints,
    exactTriangles,
    CGAL::parameters::visitor(exactVisitor).concurrency_tag(CGAL::Sequential_tag()));
  exactOwners = exactVisitor.owners(exactOwners, exactTriangles.size());
  canonicalize(exactPoints, exactTriangles, exactOwners);
  require(!PMP::does_triangle_soup_self_intersect(exactPoints, exactTriangles),
          "EXACT_REFINEMENT_FAILED",
          "Exact refinement still contains crossings.");
  std::vector<DK::Point_3> points;
  points.reserve(exactPoints.size());
  for (const auto& p : exactPoints)
    points.emplace_back(CGAL::to_double(p.x()), CGAL::to_double(p.y()), CGAL::to_double(p.z()));
  auto       triangles = exactTriangles;
  Visitor    snapVisitor(triangles.size());
  const bool snapped = PMP::autorefine_triangle_soup(points,
                                                     triangles,
                                                     CGAL::parameters::visitor(snapVisitor)
                                                       .concurrency_tag(CGAL::Sequential_tag())
                                                       .apply_iterative_snap_rounding(true)
                                                       .snap_grid_size(grid)
                                                       .number_of_iterations(unsigned(iterations)));
  require(snapped,
          "SNAP_ROUNDING_INCOMPLETE",
          "No result was published: snapping did not complete within its iteration limit.");
  auto owners = snapVisitor.owners(exactOwners, triangles.size());
  canonicalize(points, triangles, owners);
  require(!PMP::does_triangle_soup_self_intersect(points, triangles),
          "OUTPUT_INTERSECTIONS",
          "Double-precision output still contains crossings.");
  std::vector<EK::Point_3> checked;
  checked.reserve(points.size());
  for (const auto& p : points)
    checked.emplace_back(p.x(), p.y(), p.z());
  std::vector<long double> covered(originalTriangles.size(), 0);
  double                   maxDeviation = 0, maxAreaError = 0;
  std::size_t              ownerReferences = 0;
  for (std::size_t i = 0; i < triangles.size(); ++i)
  {
    const auto&  t = triangles[i];
    const double a = area(checked[t[0]], checked[t[1]], checked[t[2]]);
    require(a > 0, "INVALID_OUTPUT", "Refinement produced a zero-area triangle.");
    require(ownerReferences + owners[i].size() <= MaxOwnerReferences,
            "SOURCE_MAP_LIMIT",
            "Too many source references.");
    ownerReferences += owners[i].size();
    for (const auto source : owners[i])
    {
      require(source < originalTriangles.size(),
              "SOURCE_MAP_INVALID",
              "Output references an unknown original triangle.");
      const auto&          original = originalTriangles[source];
      const EK::Triangle_3 support(originalPoints[original[0]],
                                   originalPoints[original[1]],
                                   originalPoints[original[2]]);
      for (const auto vertex : t)
      {
        const double d =
          std::sqrt(CGAL::to_double(CGAL::squared_distance(checked[vertex], support)));
        require(std::isfinite(d) && d <= tolerance,
                "GEOMETRY_DRIFT",
                "Refinement exceeds the explicit source-surface tolerance.");
        maxDeviation = std::max(maxDeviation, d);
      }
      covered[source] += a;
    }
  }
  for (std::size_t i = 0; i < originalTriangles.size(); ++i)
  {
    const auto&  t = originalTriangles[i];
    const double a = area(originalPoints[t[0]], originalPoints[t[1]], originalPoints[t[2]]);
    if (a == 0)
      continue;
    require(covered[i] > 0,
            "SOURCE_COVERAGE_LOST",
            "A nondegenerate source triangle disappeared during repair.");
    const double error = std::abs(double(covered[i]) - a) / a;
    require(error <= 2e-6,
            "SOURCE_COVERAGE_CHANGED",
            "Source coverage changed beyond the source area tolerance.");
    maxAreaError = std::max(maxAreaError, error);
  }
  auto result = JsonValue::MakeObject(), outputPoints = JsonValue::MakeArray(),
       outputTriangles = JsonValue::MakeArray(), outputOwners = JsonValue::MakeArray();
  for (const auto& p : points)
  {
    auto row          = JsonValue::MakeArray();
    row.ChangeArray() = {number(p.x()), number(p.y()), number(p.z())};
    outputPoints.ChangeArray().push_back(std::move(row));
  }
  for (std::size_t i = 0; i < triangles.size(); ++i)
  {
    auto row = JsonValue::MakeArray(), source = JsonValue::MakeArray();
    for (const auto v : triangles[i])
      row.ChangeArray().push_back(integer(v));
    for (const auto id : owners[i])
      source.ChangeArray().push_back(integer(id));
    outputTriangles.ChangeArray().push_back(std::move(row));
    outputOwners.ChangeArray().push_back(std::move(source));
  }
  auto& data                = result.ChangeObject();
  data["ok"]                = JsonValue(true);
  data["cgalVersion"]       = JsonValue(std::string(CGAL_VERSION_STR));
  data["basis"]             = JsonValue(std::string("exact-autorefinement-then-iterative-snap-v1"));
  data["units"]             = JsonValue(std::string("mm"));
  data["points"]            = std::move(outputPoints);
  data["triangles"]         = std::move(outputTriangles);
  data["sourceTriangleIds"] = std::move(outputOwners);
  data["sources"]           = request.At("sources");
  auto  report              = JsonValue::MakeObject();
  auto& summary             = report.ChangeObject();
  summary["inputTriangles"] = integer(originalTriangles.size());
  summary["distinctInputTriangles"]     = integer(distinctInputTriangles);
  summary["outputTriangles"]            = integer(triangles.size());
  summary["inputHadCrossings"]          = JsonValue(inputCrossings);
  summary["outputHasCrossings"]         = JsonValue(false);
  summary["sourceReferences"]           = integer(ownerReferences);
  summary["maxSourceDeviation"]         = number(maxDeviation);
  summary["maxRelativeSourceAreaError"] = number(maxAreaError);
  summary["tolerance"]                  = number(tolerance);
  summary["snapGridSize"]               = number(grid);
  summary["iterationLimit"]             = number(iterations);
  auto removed                          = JsonValue::MakeArray();
  for (const auto id : degenerate)
    removed.ChangeArray().push_back(integer(id));
  summary["removedDegenerateInputTriangles"] = std::move(removed);
  summary["volumeDomainReconstruction"]      = JsonValue(std::string("not-performed"));
  summary["tetrahedralReady"]                = JsonValue(false);
  summary["sourceIdentityAuthority"] =
    JsonValue(std::string("caller-supplied-discrete-labels-not-cad-certificates"));
  data["report"] = std::move(report);
  return result;
}
} // namespace

namespace occweb
{
JsonValue RefineDiscreteSurface(const JsonValue& request)
{
  try{return refine(request);}
  catch(const Failure& error){throw DiscreteSurfaceError(error.Code,error.what());}
}
}
