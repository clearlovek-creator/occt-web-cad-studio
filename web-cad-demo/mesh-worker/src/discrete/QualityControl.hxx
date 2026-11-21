// SPDX-License-Identifier: GPL-3.0-or-later
#pragma once

#include "protocol/Json.hxx"
#include <array>
#include <functional>
#include <map>
#include <stdexcept>
#include <string>
#include <vector>

namespace occweb::discrete {
using Point = std::array<double, 3>;

struct QualityError : std::runtime_error {
  std::string code;
  QualityError(std::string code, std::string message);
};

struct Controls {
  std::string method;
  int iterations = 1;
  double threshold = .2;
  double maxBadFraction = 0;
  bool strict = false;
  bool allowRegression = false;
};

Controls parseControls(const occweb::JsonValue& request);

// Signed inverse Frobenius condition number relative to an equilateral tet.
// Recomputed from coordinates, independently of Gmsh's quality API.
double signedInverseCondition(const Point&, const Point&, const Point&, const Point&);

struct CellQuality {
  std::size_t count = 0, bad = 0;
  double minimum = 1;
};
struct QualitySnapshot {
  std::vector<CellQuality> cells;
  CellQuality all;
  double maxMetricDifference = 0;
};
struct QualityRegression {
  std::vector<std::size_t> cells;
  bool global = false;
};
QualityRegression compareQuality(const QualitySnapshot& before, const QualitySnapshot& after);

QualitySnapshot captureQuality(std::size_t cells, double threshold);
occweb::JsonValue qualityJson(const QualitySnapshot&, const Controls&);

struct BoundarySnapshot {
  std::map<int, std::vector<std::array<std::size_t, 3>>> triangles;
  std::map<std::size_t, Point> nodes;
  bool operator==(const BoundarySnapshot& other) const;
};
BoundarySnapshot captureBoundary(std::size_t surfaces);
occweb::JsonValue optimizeAndCheck(const Controls&, std::size_t cells, std::size_t surfaces,
                                 const std::function<void()>& canonicalize = {});
} // namespace occweb::discrete
