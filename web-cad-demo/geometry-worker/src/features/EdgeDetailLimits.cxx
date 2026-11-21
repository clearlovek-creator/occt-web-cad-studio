#include "EdgeDetailLimits.hxx"
#include "../document/CadError.hxx"
#include <BRepAdaptor_Curve.hxx>
#include <BRepAdaptor_Surface.hxx>
#include <BRep_Tool.hxx>
#include <Precision.hxx>
#include <TopExp.hxx>
#include <TopExp_Explorer.hxx>
#include <TopTools_IndexedDataMapOfShapeListOfShape.hxx>
#include <TopoDS.hxx>
#include <gp_Pln.hxx>
#include <gp_Lin.hxx>
#include <algorithm>
#include <cmath>

namespace occweb {
void ValidatePlanarEdgeDetail(const TopoDS_Shape& shape,const TopoDS_Edge& edge,const double size,const bool fillet){
  BRepAdaptor_Curve curve(edge);if(curve.GetType()!=GeomAbs_Line)return;
  TopTools_IndexedDataMapOfShapeListOfShape adjacent;TopExp::MapShapesAndAncestors(shape,TopAbs_EDGE,TopAbs_FACE,adjacent);
  if(!adjacent.Contains(edge)||adjacent.FindFromKey(edge).Extent()!=2)return;
  const auto& faces=adjacent.FindFromKey(edge);gp_Dir normal[2];double extent[2]={0,0};int index=0;
  const auto origin=curve.Line().Location();const auto tangent=curve.Line().Direction();
  for(const auto& item:faces){
    const auto face=TopoDS::Face(item);BRepAdaptor_Surface surface(face);if(surface.GetType()!=GeomAbs_Plane)return;
    normal[index]=surface.Plane().Axis().Direction();if(face.Orientation()==TopAbs_REVERSED)normal[index].Reverse();
    const gp_Vec side=gp_Vec(tangent).Crossed(gp_Vec(normal[index]));if(side.SquareMagnitude()<1e-20)return;
    for(TopExp_Explorer edges(face,TopAbs_EDGE);edges.More();edges.Next())if(BRepAdaptor_Curve(TopoDS::Edge(edges.Current())).GetType()!=GeomAbs_Line)return;
    for(TopExp_Explorer vertices(face,TopAbs_VERTEX);vertices.More();vertices.Next())extent[index]=std::max(extent[index],std::abs(gp_Vec(origin,BRep_Tool::Pnt(TopoDS::Vertex(vertices.Current()))).Dot(side)));
    ++index;
  }
  const double cosine=std::clamp(normal[0].Dot(normal[1]),-1.0,1.0);if(std::abs(cosine)>1.0-1e-12)return;
  // Planar fillet tangency setback = R*cot(interior_angle/2).
  // A symmetric chamfer's distance is already measured on each adjacent face.
  const double setback=fillet?size*std::sqrt((1.0-cosine)/(1.0+cosine)):size;
  for(const double width:extent)if(setback>width+Precision::Confusion()+1e-10*std::max(setback,width))
    throw CadError("INVALID_PARAMETER",fillet?"Fillet tangency lies outside the selected edge's adjacent planar faces. Try a smaller radius.":"Chamfer distance exceeds the selected edge's adjacent planar faces. Try a smaller distance.");
}
}
