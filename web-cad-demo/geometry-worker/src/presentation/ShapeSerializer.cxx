#include "ShapeSerializer.hxx"

#include <BRepAdaptor_Curve.hxx>
#include <BRepMesh_IncrementalMesh.hxx>
#include <BRep_Tool.hxx>
#include <GeomAbs_CurveType.hxx>
#include <Poly_Triangulation.hxx>
#include <TopAbs_Orientation.hxx>
#include <TopExp.hxx>
#include <TopLoc_Location.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Edge.hxx>
#include <TopoDS_Face.hxx>
#include <gp_Pnt.hxx>
#include <gp_Trsf.hxx>
#include <gp_Vec.hxx>

#include <cmath>
#include <cstdlib>
#include <iomanip>
#include <sstream>

namespace
{
void writePoint(std::ostream& out, const gp_Pnt& point)
{
  out << point.X() << ',' << point.Y() << ',' << point.Z();
}

void writeVector(std::ostream& out, const gp_Vec& vector)
{
  out << vector.X() << ',' << vector.Y() << ',' << vector.Z();
}

double environmentDouble(const char* name, const double fallback)
{
  const char* value = std::getenv(name);
  if (value == nullptr) return fallback;
  char* end = nullptr;
  const double parsed = std::strtod(value, &end);
  return end != value && std::isfinite(parsed) && parsed > 0.0 ? parsed : fallback;
}

std::size_t environmentSize(const char* name, const std::size_t fallback)
{
  const char* value = std::getenv(name);
  if (value == nullptr) return fallback;
  char* end = nullptr;
  const unsigned long long parsed = std::strtoull(value, &end, 10);
  return end != value && parsed > 0 ? static_cast<std::size_t>(parsed) : fallback;
}

occweb::ShapeSerializationLimits resolveLimits(occweb::ShapeSerializationLimits limits)
{
  if (limits.linearDeflection <= 0.0)
    limits.linearDeflection = environmentDouble("OCCT_WEB_MESH_LINEAR_DEFLECTION", 0.35);
  if (limits.angularDeflection <= 0.0)
    limits.angularDeflection = environmentDouble("OCCT_WEB_MESH_ANGULAR_DEFLECTION", 0.25);
  if (limits.maxTriangles == 0)
    limits.maxTriangles = environmentSize("OCCT_WEB_MAX_TRIANGLES", 250000);
  if (limits.maxEdges == 0)
    limits.maxEdges = environmentSize("OCCT_WEB_MAX_EDGES", 20000);
  if (limits.edgeSamples == 0)
    limits.edgeSamples = environmentSize("OCCT_WEB_EDGE_SAMPLES", 25);
  return limits;
}
}

namespace occweb
{
ShapeSerializer::ShapeSerializer(const TopoDS_Shape& shape, const int revision, std::string bodyId,
                                 ShapeSerializationLimits limits)
    : myShape(shape), myRevision(revision), myBodyId(std::move(bodyId)), myLimits(resolveLimits(limits))
{
  TopExp::MapShapes(myShape, TopAbs_FACE, myFaces);
  TopExp::MapShapes(myShape, TopAbs_EDGE, myEdges);
}

std::string ShapeSerializer::faceId(const int index) const
{
  return "face-" + std::to_string(myRevision) + '-' + std::to_string(index);
}

std::string ShapeSerializer::edgeId(const int index) const
{
  return "edge-" + std::to_string(myRevision) + '-' + std::to_string(index);
}

int ShapeSerializer::EdgeIndexFromId(const std::string& value) const
{
  const std::string prefix = "edge-" + std::to_string(myRevision) + '-';
  if (value.rfind(prefix, 0) != 0) return 0;
  try { return std::stoi(value.substr(prefix.size())); }
  catch (...) { return 0; }
}

int ShapeSerializer::FaceIndexFromId(const std::string& value) const
{
  const std::string prefix = "face-" + std::to_string(myRevision) + '-';
  if (value.rfind(prefix, 0) != 0) return 0;
  try { return std::stoi(value.substr(prefix.size())); }
  catch (...) { return 0; }
}

std::string ShapeSerializer::Serialize(const std::string& prefix) const
{
  const std::string body = SerializeBody();
  return prefix + ',' + body.substr(1);
}

std::string ShapeSerializer::SerializeBody() const
{
  BRepMesh_IncrementalMesh mesher(myShape, myLimits.linearDeflection, false, myLimits.angularDeflection, true);
  mesher.Perform();
  if (!mesher.IsDone()) throw std::runtime_error("OCCT meshing failed.");

  std::ostringstream positions, normals, indices, triangleFaceIds;
  positions << std::setprecision(10);
  normals << std::setprecision(10);
  bool firstPosition = true, firstNormal = true, firstIndex = true, firstFaceId = true;
  int vertexIndex = 0, triangleCount = 0;
  bool truncated = false;

  for (int faceIndex = 1; faceIndex <= myFaces.Extent(); ++faceIndex)
  {
    const TopoDS_Face& face = TopoDS::Face(myFaces(faceIndex));
    TopLoc_Location location;
    const Handle(Poly_Triangulation) triangulation = BRep_Tool::Triangulation(face, location);
    if (triangulation.IsNull() || !triangulation->HasGeometry()) continue;
    const gp_Trsf transform = location.Transformation();
    for (int triangleIndex = 1; triangleIndex <= triangulation->NbTriangles(); ++triangleIndex)
    {
      if (static_cast<std::size_t>(triangleCount) >= myLimits.maxTriangles)
      {
        truncated = true;
        break;
      }
      int node1 = 0, node2 = 0, node3 = 0;
      if (face.Orientation() == TopAbs_REVERSED)
        triangulation->Triangle(triangleIndex).Get(node1, node3, node2);
      else
        triangulation->Triangle(triangleIndex).Get(node1, node2, node3);

      gp_Pnt points[3] = { triangulation->Node(node1), triangulation->Node(node2), triangulation->Node(node3) };
      if (!location.IsIdentity()) for (gp_Pnt& point : points) point.Transform(transform);
      gp_Vec normal = gp_Vec(points[0], points[1]).Crossed(gp_Vec(points[0], points[2]));
      if (normal.SquareMagnitude() <= 1.0e-18) continue;
      normal.Normalize();
      for (const gp_Pnt& point : points)
      {
        if (!firstPosition) positions << ',';
        writePoint(positions, point); firstPosition = false;
        if (!firstNormal) normals << ',';
        writeVector(normals, normal); firstNormal = false;
        if (!firstIndex) indices << ',';
        indices << vertexIndex++; firstIndex = false;
      }
      if (!firstFaceId) triangleFaceIds << ',';
      triangleFaceIds << '"' << faceId(faceIndex) << '"'; firstFaceId = false;
      ++triangleCount;
    }
    if (truncated) break;
  }

  std::ostringstream edges;
  edges << std::setprecision(10) << '[';
  bool firstEdge = true;
  std::size_t serializedEdges = 0;
  for (int edgeIndex = 1; edgeIndex <= myEdges.Extent(); ++edgeIndex)
  {
    const TopoDS_Edge& edge = TopoDS::Edge(myEdges(edgeIndex));
    if (serializedEdges >= myLimits.maxEdges)
    {
      truncated = true;
      break;
    }
    if (BRep_Tool::Degenerated(edge)) continue;
    BRepAdaptor_Curve curve(edge);
    const double first = curve.FirstParameter(), last = curve.LastParameter();
    if (!std::isfinite(first) || !std::isfinite(last) || last <= first) continue;
    const int samples = curve.GetType() == GeomAbs_Line ? 2 : static_cast<int>(myLimits.edgeSamples);
    if (!firstEdge) edges << ',';
    edges << "{\"edgeId\":\"" << edgeId(edgeIndex) << "\",\"points\":[";
    for (int sample = 0; sample < samples; ++sample)
    {
      if (sample > 0) edges << ',';
      writePoint(edges, curve.Value(first + (last - first) * sample / (samples - 1.0)));
    }
    edges << "]}"; firstEdge = false;
    ++serializedEdges;
  }
  edges << ']';

  std::ostringstream output;
  output << "{\"bodyId\":\"" << myBodyId << '"'
         << ",\"topologyRevision\":" << myRevision
         << ",\"positions\":[" << positions.str() << ']'
         << ",\"normals\":[" << normals.str() << ']'
         << ",\"indices\":[" << indices.str() << ']'
         << ",\"triangleFaceIds\":[" << triangleFaceIds.str() << ']'
         << ",\"edges\":" << edges.str()
         << ",\"stats\":{\"faceCount\":" << myFaces.Extent()
         << ",\"edgeCount\":" << myEdges.Extent()
         << ",\"triangleCount\":" << triangleCount
         << ",\"truncated\":" << (truncated ? "true" : "false") << "}}";
  return output.str();
}
}
