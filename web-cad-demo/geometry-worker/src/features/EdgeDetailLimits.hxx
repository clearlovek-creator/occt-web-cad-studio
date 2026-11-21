#pragma once
#include <TopoDS_Shape.hxx>
#include <TopoDS_Edge.hxx>
namespace occweb {
// Conservative proof only for straight edges between polygonal planar faces.
// Other geometry remains the kernel's responsibility, not a bounding-box guess.
void ValidatePlanarEdgeDetail(const TopoDS_Shape& shape,const TopoDS_Edge& edge,double size,bool fillet);
}
