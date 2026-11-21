#pragma once
#include "CadError.hxx"
#include <BRepLib.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Solid.hxx>

namespace occweb
{
inline TopoDS_Shape OrientClosedSolidResult(TopoDS_Shape shape)
{
  if (!shape.IsNull() && shape.ShapeType() == TopAbs_SOLID)
  {
    auto solid = TopoDS::Solid(shape);
    if (!BRepLib::OrientClosedSolid(solid))
      throw CadError("INVALID_RESULT", "The generated solid cannot be oriented as a closed finite volume.");
    shape = solid;
  }
  return shape;
}
}
