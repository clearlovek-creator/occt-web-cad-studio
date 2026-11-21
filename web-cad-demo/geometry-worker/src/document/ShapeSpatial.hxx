#pragma once
#include <TopoDS_Shape.hxx>
#include <Bnd_Box.hxx>
#include <gp_Pnt.hxx>
#include <string>
#include <memory>

namespace occweb {
// Query geometry, not its optional presentation mesh. Numerical curve/surface
// extrema still use OCCT's Precision::Confusion; this is not an exact-arithmetic promise.
Bnd_Box AnalyticBounds(const TopoDS_Shape& shape);
std::string SpatialBoundsJson(const TopoDS_Shape& shape);
std::string SpatialObbJson(const TopoDS_Shape& shape);
std::string SpatialNumber(double value);
std::string SpatialPointJson(const gp_Pnt& point);
std::string SpatialPolicyJson();
std::string SpatialIndexCertificateJson(const TopoDS_Shape& shape);
struct SpatialMetadata {
  TopoDS_Shape Shape;
  std::string Kind;
  std::string Fields;
};
// Body geometry is immutable except for presentation triangulation. Cache only
// analytic fields and check actual TShape/location/orientation before reuse.
std::shared_ptr<const SpatialMetadata> BuildSpatialMetadata(const TopoDS_Shape& shape,const std::string& kind);
}
