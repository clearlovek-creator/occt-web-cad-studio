#pragma once

#include <NCollection_IndexedMap.hxx>
#include <TopoDS_Shape.hxx>
#include <TopTools_ShapeMapHasher.hxx>

#include <cstddef>
#include <string>
#include <stdexcept>

namespace occweb
{
struct ShapeSerializationLimits
{
  double linearDeflection = 0.0;
  double angularDeflection = 0.0;
  std::size_t maxTriangles = 0;
  std::size_t maxEdges = 0;
  std::size_t edgeSamples = 0;
};

class ShapeSerializer
{
public:
  ShapeSerializer(const TopoDS_Shape& shape, int revision, std::string bodyId,
                  ShapeSerializationLimits limits = {});

  const NCollection_IndexedMap<TopoDS_Shape, TopTools_ShapeMapHasher>& Edges() const
  {
    return myEdges;
  }

  const NCollection_IndexedMap<TopoDS_Shape, TopTools_ShapeMapHasher>& Faces() const
  {
    return myFaces;
  }

  std::string Serialize(const std::string& prefix) const;
  std::string SerializeBody() const;
  int EdgeIndexFromId(const std::string& edgeId) const;
  int FaceIndexFromId(const std::string& faceId) const;
  std::string FaceIdAt(int index) const {if(index<1||index>myFaces.Extent())throw std::out_of_range("Face index is out of range.");return faceId(index);}
  std::string EdgeIdAt(int index) const {if(index<1||index>myEdges.Extent())throw std::out_of_range("Edge index is out of range.");return edgeId(index);}

private:
  std::string faceId(int index) const;
  std::string edgeId(int index) const;

private:
  TopoDS_Shape myShape;
  int myRevision;
  std::string myBodyId;
  ShapeSerializationLimits myLimits;
  NCollection_IndexedMap<TopoDS_Shape, TopTools_ShapeMapHasher> myFaces;
  NCollection_IndexedMap<TopoDS_Shape, TopTools_ShapeMapHasher> myEdges;
};
}
