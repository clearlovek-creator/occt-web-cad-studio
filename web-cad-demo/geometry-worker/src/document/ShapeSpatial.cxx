#include "ShapeSpatial.hxx"
#include "CadError.hxx"
#include <BRepBndLib.hxx>
#include <Bnd_OBB.hxx>
#include <BRepGProp.hxx>
#include <GProp_GProps.hxx>
#include <TopExp.hxx>
#include <TopTools_IndexedMapOfShape.hxx>
#include <cmath>
#include <iomanip>
#include <limits>
#include <locale>
#include <sstream>

namespace occweb {
std::string SpatialNumber(double value) {
  if(!std::isfinite(value))throw CadError("SPATIAL_DATA_UNAVAILABLE","Non-finite spatial data cannot be serialized.");
  std::ostringstream out;out.imbue(std::locale::classic());
  out<<std::setprecision(std::numeric_limits<double>::max_digits10)<<(value==0.0?0.0:value);
  return out.str();
}
std::string SpatialPointJson(const gp_Pnt& point) {
  return '['+SpatialNumber(point.X())+','+SpatialNumber(point.Y())+','+SpatialNumber(point.Z())+']';
}
Bnd_Box AnalyticBounds(const TopoDS_Shape& shape) {
  Bnd_Box result;if(!shape.IsNull())BRepBndLib::AddOptimal(shape,result,false,false);return result;
}
std::string SpatialBoundsJson(const TopoDS_Shape& shape) {
  const auto bounds=AnalyticBounds(shape);if(bounds.IsVoid()||bounds.IsOpen())return "null";
  double a,b,c,d,e,f;bounds.Get(a,b,c,d,e,f);
  if(!std::isfinite(a)||!std::isfinite(b)||!std::isfinite(c)||!std::isfinite(d)||!std::isfinite(e)||!std::isfinite(f))return "null";
  return "{\"min\":"+SpatialPointJson(gp_Pnt(a,b,c))+",\"max\":"+SpatialPointJson(gp_Pnt(d,e,f))+"}";
}
std::string SpatialObbJson(const TopoDS_Shape& shape) {
  if(shape.IsNull())return "null";
  Bnd_OBB obb;BRepBndLib::AddOBB(shape,obb,false,true,false);if(obb.IsVoid())return "null";
  const auto xyz=[](const gp_XYZ& point){return SpatialPointJson(gp_Pnt(point));};
  // OCCT may choose inertia axes. It does not prove a globally minimum-volume box.
  return "{\"center\":"+xyz(obb.Center())+",\"axes\":["+xyz(obb.XDirection())+','+xyz(obb.YDirection())+','+xyz(obb.ZDirection())+"]"
    +",\"halfSizes\":["+SpatialNumber(obb.XHSize())+','+SpatialNumber(obb.YHSize())+','+SpatialNumber(obb.ZHSize())+"]"
    +",\"source\":\"occt-brep-obb\",\"exact\":false,\"minimum\":false,\"triangulationUsed\":false,\"toleranceExpanded\":false}";
}
std::string SpatialPolicyJson() {
  return "{\"version\":1,\"aabb\":\"occt-brep-optimal\",\"triangulationUsed\":false,\"toleranceExpanded\":false,\"precision\":\"float64-roundtrip\",\"numericalExtrema\":\"occt-confusion-tolerance\"}";
}
std::string SpatialIndexCertificateJson(const TopoDS_Shape& shape) {
  // Gmsh's OCC import certificate uses the conservative OCC box, not the
  // optimal analysis AABB. Keep the protocol explicit and mesh-independent.
  Bnd_Box box;BRepBndLib::Add(shape,box,false);
  if(box.IsVoid()||box.IsOpen())throw CadError("MESH_CERTIFICATE_UNAVAILABLE","No finite BRep index certificate bounds.");
  double a,b,c,d,e,f;box.Get(a,b,c,d,e,f);
  return "{\"version\":1,\"boundsPolicy\":\"occt-brep-conservative\",\"triangulationUsed\":false,\"bounds\":{\"min\":"+SpatialPointJson(gp_Pnt(a,b,c))+",\"max\":"+SpatialPointJson(gp_Pnt(d,e,f))+"}}";
}
std::shared_ptr<const SpatialMetadata> BuildSpatialMetadata(const TopoDS_Shape& shape,const std::string& kind) {
  auto data=std::make_shared<SpatialMetadata>();data->Shape=shape;data->Kind=kind;
  GProp_GProps volume,area,center;BRepGProp::SurfaceProperties(shape,area);
  if(kind=="solid"){BRepGProp::VolumeProperties(shape,volume);center=volume;}
  else if(kind=="wire")BRepGProp::LinearProperties(shape,center);else center=area;
  TopTools_IndexedMapOfShape faces,edges;TopExp::MapShapes(shape,TopAbs_FACE,faces);TopExp::MapShapes(shape,TopAbs_EDGE,edges);
  data->Fields=",\"faceCount\":"+std::to_string(faces.Extent())+",\"edgeCount\":"+std::to_string(edges.Extent())
    +",\"volume\":"+SpatialNumber(volume.Mass())+",\"area\":"+SpatialNumber(area.Mass())
    +",\"centroid\":"+SpatialPointJson(center.CentreOfMass())+",\"bounds\":"+SpatialBoundsJson(shape);
  return data;
}
}
