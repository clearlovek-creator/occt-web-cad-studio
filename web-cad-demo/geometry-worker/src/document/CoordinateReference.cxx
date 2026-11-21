#include "CoordinateReference.hxx"
#include "CadError.hxx"
#include "../presentation/ShapeSerializer.hxx"

#include <BRepAdaptor_Surface.hxx>
#include <TopoDS.hxx>
#include <gp_Ax3.hxx>
#include <gp_Trsf.hxx>
#include <Standard_Failure.hxx>
#include <Standard_OutOfMemory.hxx>
#include <algorithm>
#include <cmath>
#include <map>
#include <set>

namespace occweb
{
namespace
{
[[noreturn]] void unresolved(const std::string& id, const std::string& reason)
{
  throw CadError("COORDINATE_REFERENCE_UNRESOLVED", "面坐标系 " + id + " 无法解析：" + reason,
    "{\"coordinateSystemId\":\"" + JsonEscape(id) + "\"}");
}
gp_Ax3 coordinateAxis(const CoordinateSystemRecord& record)
{
  const gp_Vec x(record.XAxis[0],record.XAxis[1],record.XAxis[2]);
  const gp_Vec y(record.YAxis[0],record.YAxis[1],record.YAxis[2]);
  return gp_Ax3(gp_Pnt(record.Origin[0],record.Origin[1],record.Origin[2]),gp_Dir(x.Crossed(y)),gp_Dir(x));
}
}

void UpdateFaceCoordinateFrame(CoordinateSystemRecord& record, const TopoDS_Face& face,
                               const bool orthonormal)
{
  BRepAdaptor_Surface surface(face);
  const double u = surface.FirstUParameter()*.5 + surface.LastUParameter()*.5;
  const double v = surface.FirstVParameter()*.5 + surface.LastVParameter()*.5;
  if (!std::isfinite(u) || !std::isfinite(v))
    throw CadError("INVALID_COORDINATE_SYSTEM", "所选面没有有限的参数范围，不能生成稳定坐标系。");
  gp_Pnt point; gp_Vec du, dv; surface.D1(u,v,point,du,dv);
  if (!std::isfinite(point.X()) || !std::isfinite(point.Y()) || !std::isfinite(point.Z())
      || !std::isfinite(du.SquareMagnitude()) || !std::isfinite(dv.SquareMagnitude())
      || !std::isfinite(du.Crossed(dv).SquareMagnitude())
      || du.SquareMagnitude()<1e-24 || dv.SquareMagnitude()<1e-24 || du.Crossed(dv).SquareMagnitude()<1e-24)
    throw CadError("INVALID_COORDINATE_SYSTEM", "所选面的参数切向退化，不能生成稳定坐标系。");
  if (orthonormal)
  {
    du.Normalize();
    gp_Vec normal=du.Crossed(dv).Normalized();
    if (face.Orientation()==TopAbs_REVERSED) normal.Reverse();
    dv=normal.Crossed(du).Normalized();
  }
  record.Origin={point.X(),point.Y(),point.Z()};
  record.XAxis={du.X(),du.Y(),du.Z()};
  record.YAxis={dv.X(),dv.Y(),dv.Z()};
}

void ResolveFaceCoordinate(CoordinateSystemRecord& record, const TopoDS_Shape& shape,
                          const TopologyNames& names)
{
  try
  {
    const int index=TopologyNaming::ResolveSelection(shape,names,record.ReferenceSelector);
    ShapeSerializer topology(shape,0,record.ReferenceBodyId);
    UpdateFaceCoordinateFrame(record,TopoDS::Face(topology.Faces()(index)));
    record.ResolvedFaceIndex=index;
    record.ReferenceState="resolved";
    record.ReferenceDiagnostic.clear();
  }
  catch (const CadError& error)
  {
    record.ReferenceState="unresolved";
    record.ReferenceDiagnostic=error.what();
    record.ResolvedFaceIndex=0;
  }
  catch (const Standard_OutOfMemory&) { throw; }
  catch (const Standard_Failure& error)
  {
    record.ReferenceState="unresolved";record.ResolvedFaceIndex=0;
    record.ReferenceDiagnostic=std::string("内核无法建立来源面的稳定坐标：")+error.what();
  }
}

std::vector<std::string> FeatureCoordinateIds(const FeatureNode& feature)
{
  std::vector<std::string> ids;
  for (const auto* key:{"coordinateSystemId","sourceCoordinateSystemId","targetCoordinateSystemId"})
    if (const auto found=feature.StringParameters.find(key);found!=feature.StringParameters.end() && !found->second.empty())
      ids.push_back(found->second);
  return ids;
}

std::set<std::string> FeatureCoordinateSources(const FeatureNode& feature,
                                             const CoordinateSystemStore& coordinates)
{
  std::set<std::string> result;
  if (feature.State=="suppressed") return result;
  for (const auto& id:FeatureCoordinateIds(feature))
    if (const auto found=coordinates.Records().find(id);found!=coordinates.Records().end()
        && found->second.AssociationMode=="associative")
      result.insert(found->second.ReferenceFeatureId);
  return result;
}

std::vector<std::size_t> CoordinateReplayOrder(const std::vector<FeatureNode>& features,
                                              const CoordinateSystemStore& coordinates,
                                              const std::string& inspectionFeatureId)
{
  std::map<std::string,std::size_t> indices;
  for (std::size_t i=0;i<features.size();++i) indices[features[i].Id]=i;
  std::vector<std::set<std::size_t>> edges(features.size());
  std::vector<int> incoming(features.size(),0);
  const auto dependenciesFor=[&](const std::size_t i)
  {
    std::set<std::string> dependencies(features[i].InputFeatures.begin(),features[i].InputFeatures.end());
    if (features[i].State!="suppressed")
      for (const auto& id:FeatureCoordinateIds(features[i]))
      {
        if (id=="global") continue;
        const auto found=coordinates.Records().find(id);
        if (found==coordinates.Records().end()) throw CadError("COORDINATE_SYSTEM_NOT_FOUND","Coordinate system does not exist: "+id);
        const auto& record=found->second;
        if (record.AssociationMode!="associative") continue;
        const auto source=indices.find(record.ReferenceFeatureId);
        if (source==indices.end() || features[source->second].Identity!=record.ReferenceFeatureIdentity)
          unresolved(id,"来源特征已删除或身份不匹配，请显式重新关联。");
        dependencies.insert(record.ReferenceFeatureId);
      }
    return dependencies;
  };
  // Read-only inspection needs its true ancestor closure, not unrelated model
  // branches. In particular, another coordinate being repaired may still have
  // a deleted source. Full validation/commit deliberately leaves this empty
  // and checks the entire graph with the same dependency/cycle rules.
  std::set<std::size_t> included;
  std::map<std::size_t,std::set<std::string>> dependencies;
  std::vector<std::size_t> pending;
  if(inspectionFeatureId.empty())
    for(std::size_t i=features.size();i>0;--i)pending.push_back(i-1);
  else
  {
    const auto target=indices.find(inspectionFeatureId);
    if(target==indices.end())throw CadError("FEATURE_INPUT_UNAVAILABLE","Historical inspection target does not exist.");
    pending.push_back(target->second);
  }
  while(!pending.empty())
  {
    const auto i=pending.back();pending.pop_back();
    if(!included.insert(i).second)continue;
    auto required=dependenciesFor(i);
    for(const auto& id:required)
    {
      const auto source=indices.find(id);
      if(source==indices.end())throw CadError("INVALID_FEATURE_GRAPH","Missing input feature: "+id);
      pending.push_back(source->second);
    }
    dependencies.emplace(i,std::move(required));
  }
  for(const auto i:included)
  {
    for (const auto& dependency:dependencies.at(i))
    {
      const auto source=indices.find(dependency);
      if (source==indices.end()) throw CadError("INVALID_FEATURE_GRAPH","Missing input feature: "+dependency);
      if (edges[source->second].insert(i).second) ++incoming[i];
    }
  }
  // Stable Kahn ordering: independent geometry retains its existing order.
  std::set<std::size_t> ready;
  for (const auto i:included) if (!incoming[i]) ready.insert(i);
  std::vector<std::size_t> order;
  while (!ready.empty())
  {
    const auto i=*ready.begin();ready.erase(ready.begin());order.push_back(i);
    for (const auto next:edges[i]) if (--incoming[next]==0) ready.insert(next);
  }
  if (order.size()!=included.size())
    throw CadError("COORDINATE_DEPENDENCY_CYCLE","坐标系与特征形成循环依赖，请选择不依赖该坐标系的来源面；工程未修改。");
  return order;
}

bool ApplyFeatureCoordinates(FeatureNode& feature, const CoordinateSystemStore& coordinates)
{
  bool changed=false;
  const auto set=[&](const std::string& key,double value){
    const auto previous=feature.NumberParameters.find(key);
    if (previous==feature.NumberParameters.end() || previous->second!=value) changed=true;
    feature.NumberParameters[key]=value;
  };
  if (const auto system=feature.StringParameters.find("coordinateSystemId");system!=feature.StringParameters.end())
  {
    const auto& record=coordinates.Get(system->second);
    for (int i=0;i<3;++i)
    {
      const auto axis=std::string(1,"XYZ"[i]);
      set("csOrigin"+axis,record.Origin[i]);set("csXAxis"+axis,record.XAxis[i]);set("csYAxis"+axis,record.YAxis[i]);
    }
  }
  const auto source=feature.StringParameters.find("sourceCoordinateSystemId"),target=feature.StringParameters.find("targetCoordinateSystemId");
  if (source!=feature.StringParameters.end() && target!=feature.StringParameters.end())
  {
    gp_Trsf transform;transform.SetTransformation(coordinateAxis(coordinates.Get(source->second)),coordinateAxis(coordinates.Get(target->second)));
    for (int r=1;r<=3;++r)for (int c=1;c<=4;++c)set("m"+std::to_string(r)+std::to_string(c),transform.Value(r,c));
  }
  return changed;
}

void InvalidateMissingCoordinateSources(CoordinateSystemStore& coordinates,
                                       const std::vector<FeatureNode>& features)
{
  const auto records=coordinates.Records();
  for (auto [id,record]:records)
  {
    if (record.AssociationMode!="associative") continue;
    const auto source=std::find_if(features.begin(),features.end(),[&](const auto& feature){return feature.Id==record.ReferenceFeatureId && feature.Identity==record.ReferenceFeatureIdentity && feature.State!="suppressed";});
    if (source==features.end())
    {
      record.ReferenceState="unresolved";record.ResolvedFaceIndex=0;
      record.ReferenceDiagnostic="来源特征已删除、抑制或身份不匹配，需要显式重新关联。";
      coordinates.Set(record);
    }
  }
}
}
