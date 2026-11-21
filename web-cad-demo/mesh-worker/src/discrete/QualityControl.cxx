// SPDX-License-Identifier: GPL-3.0-or-later
#include "QualityControl.hxx"
#include "MeshSnapshot.hxx"
#include <gmsh.h>
#include <algorithm>
#include <cmath>
#include <set>
#include <utility>

namespace occweb::discrete {
namespace {
using J = occweb::JsonValue;
void check(bool valid, const char* code, const char* message) {
  if (!valid) throw QualityError(code, message);
}
Point cross(const Point& a, const Point& b) {
  return {a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]};
}
double dot(const Point& a, const Point& b) {
  return a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
}
void fields(const J& input, const std::set<std::string>& allowed) {
  check(input.IsObject(), "MESH_POLICY_INVALID", "Mesh controls must be explicit objects.");
  for (const auto& field : input.AsObject())
    check(allowed.count(field.first), "MESH_POLICY_INVALID", "Unknown mesh control setting.");
}
std::map<std::size_t, Point> nodeTable() {
  std::vector<std::size_t> tags;
  std::vector<double> xyz, parameters;
  gmsh::model::mesh::getNodes(tags, xyz, parameters, -1, -1, false, false);
  check(tags.size() <= 100000 && xyz.size() == 3*tags.size(), "MESH_OUTPUT_LIMIT", "Quality node inventory exceeds its budget.");
  std::map<std::size_t, Point> result;
  for (std::size_t i = 0; i < tags.size(); ++i) {
    Point point = {xyz[3*i], xyz[3*i+1], xyz[3*i+2]};
    check(std::all_of(point.begin(), point.end(), [](double v){return std::isfinite(v);}) && result.emplace(tags[i],point).second,
          "MESH_NODE_INVALID", "Quality inventory has an invalid or repeated node.");
  }
  return result;
}
void add(CellQuality& stats, double quality, double threshold) {
  stats.count++;
  stats.bad += quality < threshold;
  stats.minimum = std::min(stats.minimum, quality);
}
J statsJson(const CellQuality& stats, const Controls& controls) {
  auto result = J::MakeObject();
  const double fraction = stats.count ? double(stats.bad)/double(stats.count) : 1;
  result.ChangeObject()["tetraCount"] = J(double(stats.count));
  result.ChangeObject()["lowQualityCount"] = J(double(stats.bad));
  result.ChangeObject()["lowQualityFraction"] = J(fraction);
  result.ChangeObject()["minimumSICN"] = J(stats.minimum);
  result.ChangeObject()["meetsRequestedQuality"] = J(stats.count > 0 && fraction <= controls.maxBadFraction);
  return result;
}
}

QualityError::QualityError(std::string c, std::string message)
  : std::runtime_error(std::move(message)), code(std::move(c)) {}

Controls parseControls(const J& request) {
  Controls result;
  if (const auto* input = request.Find("optimization")) {
    fields(*input, {"version", "method", "iterations", "acceptance"});
    check(input->GetInteger("version") == 1, "MESH_POLICY_INVALID", "Unsupported optimization version.");
    result.method = input->GetString("method");
    check(result.method == "gmsh" || result.method == "netgen" || result.method == "relocate",
          "MESH_POLICY_INVALID", "Unsupported research optimization method.");
    result.iterations = input->GetInteger("iterations");
    check(result.iterations >= 1 && result.iterations <= 5, "MESH_POLICY_INVALID", "Optimization iterations must be 1 through 5.");
    const auto acceptance = input->GetStringOr("acceptance", "non-regressing");
    check(acceptance == "non-regressing" || acceptance == "diagnostic", "MESH_POLICY_INVALID", "Unsupported optimization acceptance rule.");
    result.allowRegression = acceptance == "diagnostic";
  }
  if (const auto* input = request.Find("quality")) {
    fields(*input, {"version", "mode", "threshold", "maxBadFraction"});
    check(input->GetInteger("version") == 1, "MESH_POLICY_INVALID", "Unsupported quality policy version.");
    const auto mode = input->GetString("mode");
    check(mode == "diagnostic" || mode == "strict", "MESH_POLICY_INVALID", "Quality mode must be diagnostic or strict.");
    result.strict = mode == "strict";
    result.threshold = input->GetNumber("threshold");
    result.maxBadFraction = input->GetNumber("maxBadFraction");
    check(std::isfinite(result.threshold) && result.threshold >= 0 && result.threshold <= 1
          && std::isfinite(result.maxBadFraction) && result.maxBadFraction >= 0 && result.maxBadFraction <= 1,
          "MESH_POLICY_INVALID", "SICN threshold and bad-cell fraction must be finite values between 0 and 1.");
  }
  return result;
}

double signedInverseCondition(const Point& a, const Point& b, const Point& c, const Point& d) {
  Point u, v, w;
  double scale = 0;
  for (int i = 0; i < 3; ++i) {
    u[i] = b[i]-a[i]; v[i] = c[i]-a[i]; w[i] = d[i]-a[i];
    scale = std::max({scale, std::abs(u[i]), std::abs(v[i]), std::abs(w[i])});
  }
  check(std::isfinite(scale) && scale > 0, "MESH_TET_INVALID", "Zero or non-finite tetrahedral extent.");
  Point x, y, z;
  for (int i = 0; i < 3; ++i) {
    u[i] /= scale; v[i] /= scale; w[i] /= scale;
    x[i] = u[i]; y[i] = (2*v[i]-u[i])/std::sqrt(3.);
    z[i] = std::sqrt(1.5)*(w[i]-(u[i]+v[i])/3);
  }
  const Point cx = cross(y,z), cy = cross(z,x), cz = cross(x,y);
  const double denominator = std::sqrt((dot(x,x)+dot(y,y)+dot(z,z))*(dot(cx,cx)+dot(cy,cy)+dot(cz,cz)));
  check(std::isfinite(denominator) && denominator > 0, "MESH_TET_INVALID", "Singular tetrahedral condition matrix.");
  return 3*dot(x,cx)/denominator;
}

QualitySnapshot captureQuality(std::size_t cells, double threshold) {
  const auto nodes = nodeTable();
  QualitySnapshot result;
  result.cells.resize(cells);
  for (std::size_t c = 0; c < cells; ++c) {
    std::vector<int> types;
    std::vector<std::vector<std::size_t>> tags, vertices;
    gmsh::model::mesh::getElements(types, tags, vertices, 3, int(c+1));
    for (std::size_t block = 0; block < types.size(); ++block) {
      check(types[block] == 4 && vertices[block].size() == 4*tags[block].size(), "MESH_ELEMENT_UNSUPPORTED", "Quality controls require first-order tetrahedra.");
      check(result.all.count+tags[block].size() <= 200000, "MESH_OUTPUT_LIMIT", "Quality tetrahedron count exceeds its budget.");
      std::vector<double> reported;
      gmsh::model::mesh::getElementQualities(tags[block], reported, "minSICN");
      check(reported.size() == tags[block].size(), "MESH_QUALITY_INVALID", "Incomplete engine quality vector.");
      for (std::size_t i = 0; i < tags[block].size(); ++i) {
        const double q = signedInverseCondition(nodes.at(vertices[block][4*i]), nodes.at(vertices[block][4*i+1]),
                                                nodes.at(vertices[block][4*i+2]), nodes.at(vertices[block][4*i+3]));
        check(std::isfinite(q) && q > 0 && q <= 1+1e-12, "MESH_TET_INVALID", "Invalid signed tetrahedral quality.");
        check(std::isfinite(reported[i]) && std::abs(q-reported[i]) <= 2e-10,
              "MESH_QUALITY_MISMATCH", "Coordinate-derived quality disagrees with the engine.");
        result.maxMetricDifference = std::max(result.maxMetricDifference, std::abs(q-reported[i]));
        add(result.cells[c], q, threshold); add(result.all, q, threshold);
      }
    }
    check(result.cells[c].count > 0, "MESH_CELL_INVALID", "A connected cell has no tetrahedra.");
  }
  return result;
}

J qualityJson(const QualitySnapshot& snapshot, const Controls& controls) {
  auto result = statsJson(snapshot.all, controls), cells = J::MakeArray();
  bool allPass = true;
  for (std::size_t c = 0; c < snapshot.cells.size(); ++c) {
    auto row = statsJson(snapshot.cells[c], controls);
    allPass = allPass && row.At("meetsRequestedQuality").AsBoolean();
    row.ChangeObject()["cellIndex"] = J(double(c));
    cells.ChangeArray().push_back(std::move(row));
  }
  result.ChangeObject()["version"] = J(1.);
  result.ChangeObject()["metric"] = J(std::string("coordinate-derived-linear-tet-SICN-v1"));
  result.ChangeObject()["mode"] = J(std::string(controls.strict ? "strict" : "diagnostic"));
  result.ChangeObject()["threshold"] = J(controls.threshold);
  result.ChangeObject()["maxBadFraction"] = J(controls.maxBadFraction);
  result.ChangeObject()["meetsRequestedQuality"] = J(allPass && result.At("meetsRequestedQuality").AsBoolean());
  result.ChangeObject()["maxEngineMetricDifference"] = J(snapshot.maxMetricDifference);
  result.ChangeObject()["perCell"] = std::move(cells);
  return result;
}

QualityRegression compareQuality(const QualitySnapshot& before, const QualitySnapshot& after) {
  check(before.cells.size()==after.cells.size(), "MESH_QUALITY_INVALID", "Optimization changed the cell inventory.");
  const auto regressed=[](const CellQuality& b,const CellQuality& a){
    check(b.count>0&&a.count>0,"MESH_QUALITY_INVALID","A quality comparison has an empty cell inventory.");
    return a.minimum+2e-10<b.minimum || double(a.bad)/double(a.count)>double(b.bad)/double(b.count)+1e-12;
  };
  QualityRegression result;
  result.global=regressed(before.all,after.all);
  for(std::size_t c=0;c<before.cells.size();++c)if(regressed(before.cells[c],after.cells[c]))result.cells.push_back(c);
  return result;
}

bool BoundarySnapshot::operator==(const BoundarySnapshot& other) const {
  return triangles == other.triangles && nodes == other.nodes;
}

BoundarySnapshot captureBoundary(std::size_t surfaces) {
  BoundarySnapshot result;
  const auto allNodes = nodeTable();
  std::size_t total = 0;
  for (std::size_t surface = 0; surface < surfaces; ++surface) {
    std::vector<int> types;
    std::vector<std::vector<std::size_t>> tags, vertices;
    gmsh::model::mesh::getElements(types, tags, vertices, 2, int(surface+1));
    auto& triangles = result.triangles[int(surface+1)];
    for (std::size_t block = 0; block < types.size(); ++block) {
      check(types[block] == 2 && vertices[block].size() == 3*tags[block].size(), "MESH_BOUNDARY_INVALID", "Boundary protection requires triangles.");
      total += tags[block].size();
      check(total <= 200000, "MESH_OUTPUT_LIMIT", "Boundary protection exceeds its budget.");
      for (std::size_t i = 0; i < tags[block].size(); ++i) {
        std::array<std::size_t,3> triangle = {vertices[block][3*i], vertices[block][3*i+1], vertices[block][3*i+2]};
        for (const auto node : triangle) result.nodes.emplace(node, allNodes.at(node));
        // Canonicalize rotation, not reflection: source orientation is protected.
        std::rotate(triangle.begin(), std::min_element(triangle.begin(),triangle.end()), triangle.end());
        triangles.push_back(triangle);
      }
    }
    check(!triangles.empty(), "MESH_BOUNDARY_MISSING", "A protected source surface has no triangles.");
    std::sort(triangles.begin(), triangles.end());
  }
  return result;
}

J optimizeAndCheck(const Controls& controls, std::size_t cells, std::size_t surfaces,
                   const std::function<void()>& canonicalize) {
  auto result = J::MakeObject();
  result.ChangeObject()["requested"] = J(!controls.method.empty());
  if (controls.method.empty()) return result;
  const auto boundary = captureBoundary(surfaces);
  const auto before = captureQuality(cells, controls.threshold);
  const auto original = captureMesh();
  gmsh::vectorpair volumes;
  for (std::size_t c = 0; c < cells; ++c) volumes.emplace_back(3,int(c+1));
  const std::string engineMethod = controls.method == "gmsh" ? "" : controls.method == "netgen" ? "Netgen" : "Relocate3D";
  gmsh::model::mesh::optimize(engineMethod, false, controls.iterations, volumes);
  validateMeshTopology(original);
  check(boundary == captureBoundary(surfaces), "MESH_OPTIMIZATION_BOUNDARY_CHANGED", "Optimization altered source boundary nodes or oriented faces.");
  if(canonicalize)canonicalize();
  check(boundary == captureBoundary(surfaces), "MESH_OPTIMIZATION_BOUNDARY_CHANGED", "Coordinate publication altered protected boundary nodes or oriented faces.");
  const auto after = captureQuality(cells, controls.threshold);
  const auto regression=compareQuality(before,after);
  auto regressions = J::MakeArray();
  for(const auto c:regression.cells)regressions.ChangeArray().push_back(J(double(c)));
  const bool retained = (!regression.cells.empty() || regression.global) && !controls.allowRegression;
  auto selected = after;
  if(retained) {
    restoreMesh(original);
    check(boundary == captureBoundary(surfaces), "MESH_OPTIMIZATION_RESTORE_FAILED", "Restored boundary differs from the original.");
    selected = captureQuality(cells, controls.threshold);
    check(occweb::JsonSerialize(qualityJson(selected,controls)) == occweb::JsonSerialize(qualityJson(before,controls)),
          "MESH_OPTIMIZATION_RESTORE_FAILED", "Restored quality differs from the original.");
  }
  result.ChangeObject()["method"] = J(controls.method);
  result.ChangeObject()["iterations"] = J(double(controls.iterations));
  result.ChangeObject()["acceptance"] = J(std::string(controls.allowRegression ? "diagnostic" : "non-regressing"));
  result.ChangeObject()["disposition"] = J(std::string(retained ? "retained-original" : "optimized"));
  result.ChangeObject()["originalMeshRestoredExactly"] = J(retained);
  result.ChangeObject()["boundaryUnchanged"] = J(true);
  result.ChangeObject()["before"] = qualityJson(before,controls);
  result.ChangeObject()["candidate"] = qualityJson(after,controls);
  result.ChangeObject()["after"] = qualityJson(selected,controls);
  result.ChangeObject()["regressedCells"] = std::move(regressions);
  result.ChangeObject()["globalRegressed"] = J(regression.global);
  // Never turn optimization completion into an industrial admission claim.
  return result;
}
} // namespace occweb::discrete
