// SPDX-License-Identifier: GPL-3.0-or-later
#pragma once
#include "QualityControl.hxx"

namespace occweb::discrete {
// Translation only: mesh lengths, handedness and CAD source identities stay unchanged.
// Canonicalize to the *published* world-coordinate doubles before quality evaluation.
// Otherwise a good local mesh could become inverted/low-quality on serialization.
class LocalCoordinateFrame {
public:
  explicit LocalCoordinateFrame(Point origin) : origin_(origin) {}
  Point local(const Point& world) const;
  Point world(const Point& local) const;
  Point canonical(const Point& local) const;
  void canonicalizeMesh() const;
private:
  Point origin_;
};
} // namespace occweb::discrete
