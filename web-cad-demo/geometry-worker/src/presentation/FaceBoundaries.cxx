#include "FaceBoundaries.hxx"
#include <BRepAdaptor_Surface.hxx>
#include <BRepCheck_Analyzer.hxx>
#include <BRepCheck_Wire.hxx>
#include <BRepTools.hxx>
#include <BRepGProp.hxx>
#include <GProp_GProps.hxx>
#include <TopExp_Explorer.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Wire.hxx>
#include <cmath>
#include <set>

namespace occweb
{
JsonValue FaceBoundaries(const ShapeSerializer& topology,int faceIndex)
{
  auto result=JsonValue::MakeObject();auto& fields=result.ChangeObject();fields["version"]=JsonValue(1.0);fields["faceId"]=JsonValue(topology.FaceIdAt(faceIndex));
  const auto face=TopoDS::Face(topology.Faces()(faceIndex));const auto outer=BRepTools::OuterWire(face);
  fields["planar"]=JsonValue(BRepAdaptor_Surface(face).GetType()==GeomAbs_Plane);fields["valid"]=JsonValue(BRepCheck_Analyzer(face).IsValid());
  std::vector<TopoDS_Wire> wires;if(!outer.IsNull())wires.push_back(outer);
  for(TopExp_Explorer wire(face,TopAbs_WIRE);wire.More();wire.Next())if(!wire.Current().IsSame(outer))wires.push_back(TopoDS::Wire(wire.Current()));
  bool complete=wires.size()<=65;std::size_t references=0;auto encoded=JsonValue::MakeArray();
  for(std::size_t index=0;index<wires.size()&&index<65;++index){
    auto loop=JsonValue::MakeObject();auto& data=loop.ChangeObject();data["role"]=JsonValue(std::string(wires[index].IsSame(outer)?"outer":"inner"));data["loopId"]=JsonValue("loop-"+std::to_string(index+1));data["closed"]=JsonValue(BRepCheck_Wire(wires[index]).Closed()==BRepCheck_NoError);
    auto edges=JsonValue::MakeArray();std::set<int> unique;
    for(TopExp_Explorer edge(wires[index],TopAbs_EDGE);edge.More();edge.Next()){
      const int id=topology.Edges().FindIndex(edge.Current());if(id<1){complete=false;continue;}if(!unique.insert(id).second)continue;
      if(++references>4096){complete=false;break;}edges.ChangeArray().push_back(JsonValue(topology.EdgeIdAt(id)));
    }
    GProp_GProps properties;BRepGProp::LinearProperties(wires[index],properties);const double length=properties.Mass();
    if(!std::isfinite(length)||length<0){complete=false;data["length"]=JsonValue();}else data["length"]=JsonValue(length);
    data["edgeIds"]=edges;encoded.ChangeArray().push_back(loop);if(references>4096)break;
  }
  fields["complete"]=JsonValue(complete);fields["loops"]=encoded;return result;
}
JsonValue FaceBoundaryTable(const ShapeSerializer& topology)
{
  auto result=JsonValue::MakeObject();auto& fields=result.ChangeObject();fields["version"]=JsonValue(1.0);auto faces=JsonValue::MakeArray();bool complete=true;std::size_t references=0;
  for(int index=1;index<=topology.Faces().Extent();++index){
    if(index>5000){complete=false;break;}auto face=FaceBoundaries(topology,index);
    for(const auto& loop:face.At("loops").AsArray())references+=loop.At("edgeIds").AsArray().size();
    if(references>20000){complete=false;break;}complete=complete&&face.GetBooleanOr("complete",false);faces.ChangeArray().push_back(face);
  }
  fields["complete"]=JsonValue(complete);fields["faces"]=faces;return result;
}
}
