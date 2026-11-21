#include "CadDocument.hxx"
#include "BodyDisplayMetadata.hxx"

#include "CadError.hxx"
#include "ShapeSpatial.hxx"
#include "TopologyHistory.hxx"
#include "../presentation/ShapeSerializer.hxx"

#include <BRepBndLib.hxx>
#include <BRepBuilderAPI_GTransform.hxx>
#include <BRepBuilderAPI_Transform.hxx>
#include <BRepCheck_Analyzer.hxx>
#include <Bnd_Box.hxx>
#include <gp_Ax3.hxx>
#include <gp_GTrsf.hxx>
#include <gp_Mat.hxx>
#include <gp_Trsf.hxx>

namespace
{
gp_Ax3 coordinateAxis(const occweb::CoordinateSystemRecord& record)
{
  const gp_Vec x(record.XAxis[0], record.XAxis[1], record.XAxis[2]);
  const gp_Vec y(record.YAxis[0], record.YAxis[1], record.YAxis[2]);
  return gp_Ax3(gp_Pnt(record.Origin[0], record.Origin[1], record.Origin[2]),
                gp_Dir(x.Crossed(y)), gp_Dir(x));
}
}

namespace occweb
{
std::string CadDocument::AdvancedTransform(const std::string& requestId, const int expectedRevision,
                                           const std::string& operation, const std::string& bodyId,
                                           const JsonValue& parameters)
{
  if (expectedRevision != myRevision)
    throw CadError("STALE_REVISION", "Document revision is stale. Reload before transforming the body.");
  BodyRecord& body = bodyOrActive(bodyId);
  FeatureNode feature;
  feature.Id = nextFeatureId(); feature.Type = operation; feature.InputFeatures = {body.SourceFeatureId};

  TopoDS_Shape result;
  TopologyNames outputNames;
  TopologyRemap operationRemap;
  if (operation == "transform.copy")
  {
    const double dx = parameterValue(parameters, "dx", "length", 0.0, false, &feature);
    const double dy = parameterValue(parameters, "dy", "length", 0.0, false, &feature);
    const double dz = parameterValue(parameters, "dz", "length", 0.0, false, &feature);
    gp_Trsf transform; transform.SetTranslation(gp_Vec(dx, dy, dz));
    BRepBuilderAPI_Transform builder(body.Shape, transform, true); builder.Build();
    if (!builder.IsDone()) throw CadError("BUILD_FAILED", "OCCT could not copy the body.");
    result = builder.Shape();
    outputNames=TopologyNaming::Propagate(body.Shape,body.Names,result,builder);
    ShapeSerializer prior(body.Shape,body.TopologyRevision,body.Id),next(result,myRevision+1,body.Id);
    operationRemap=TopologyHistory::Build(prior,next,body.TopologyRevision,myRevision+1,builder);
  }
  else if (operation == "transform.scale_non_uniform")
  {
    const double sx = parameterValue(parameters, "factorX", "dimensionless", 1.0, true, &feature);
    const double sy = parameterValue(parameters, "factorY", "dimensionless", 1.0, true, &feature);
    const double sz = parameterValue(parameters, "factorZ", "dimensionless", 1.0, true, &feature);
    const double ox = parameterValue(parameters, "originX", "length", 0.0, false, &feature);
    const double oy = parameterValue(parameters, "originY", "length", 0.0, false, &feature);
    const double oz = parameterValue(parameters, "originZ", "length", 0.0, false, &feature);
    if (sx <= 0 || sy <= 0 || sz <= 0 || sx > 1000 || sy > 1000 || sz > 1000)
      throw CadError("INVALID_PARAMETER", "Non-uniform scale factors must be between 0 and 1000.");
    gp_GTrsf transform;
    transform.SetVectorialPart(gp_Mat(sx,0,0, 0,sy,0, 0,0,sz));
    transform.SetTranslationPart(gp_XYZ(ox*(1-sx), oy*(1-sy), oz*(1-sz)));
    BRepBuilderAPI_GTransform builder(body.Shape, transform, true); builder.Build();
    if (!builder.IsDone()) throw CadError("BUILD_FAILED", "OCCT could not apply non-uniform scale.");
    result = builder.Shape();
    outputNames=TopologyNaming::Propagate(body.Shape,body.Names,result,builder);
    ShapeSerializer prior(body.Shape,body.TopologyRevision,body.Id),next(result,myRevision+1,body.Id);
    operationRemap=TopologyHistory::Build(prior,next,body.TopologyRevision,myRevision+1,builder);
  }
  else if (operation == "transform.coordinate")
  {
    const std::string sourceId = parameters.GetStringOr("sourceCoordinateSystemId", "global");
    const std::string targetId = parameters.GetStringOr("targetCoordinateSystemId", "global");
    feature.StringParameters["sourceCoordinateSystemId"] = sourceId;
    feature.StringParameters["targetCoordinateSystemId"] = targetId;
    gp_Trsf transform;
    transform.SetTransformation(coordinateAxis(myCoordinateSystems.Get(sourceId)),
                                coordinateAxis(myCoordinateSystems.Get(targetId)));
    for (int row = 1; row <= 3; ++row)
      for (int column = 1; column <= 4; ++column)
        feature.NumberParameters["m" + std::to_string(row) + std::to_string(column)] = transform.Value(row, column);
    BRepBuilderAPI_Transform builder(body.Shape, transform, true); builder.Build();
    if (!builder.IsDone()) throw CadError("BUILD_FAILED", "OCCT could not transform between coordinate systems.");
    result = builder.Shape();
    outputNames=TopologyNaming::Propagate(body.Shape,body.Names,result,builder);
    ShapeSerializer prior(body.Shape,body.TopologyRevision,body.Id),next(result,myRevision+1,body.Id);
    operationRemap=TopologyHistory::Build(prior,next,body.TopologyRevision,myRevision+1,builder);
  }
  else if (operation == "transform.align")
  {
    const double targetX = parameterValue(parameters, "targetX", "length", 0.0, false, &feature);
    const double targetY = parameterValue(parameters, "targetY", "length", 0.0, false, &feature);
    const double targetZ = parameterValue(parameters, "targetZ", "length", 0.0, false, &feature);
    const std::string mode = parameters.GetStringOr("mode", "center");
    feature.StringParameters["mode"] = mode;
    Bnd_Box bounds = AnalyticBounds(body.Shape);
    if (bounds.IsVoid()) throw CadError("INVALID_RESULT", "Cannot align a body with empty bounds.");
    double xmin,ymin,zmin,xmax,ymax,zmax; bounds.Get(xmin,ymin,zmin,xmax,ymax,zmax);
    const gp_Pnt anchor = mode == "min" ? gp_Pnt(xmin,ymin,zmin)
                       : mode == "max" ? gp_Pnt(xmax,ymax,zmax)
                       : gp_Pnt((xmin+xmax)*0.5,(ymin+ymax)*0.5,(zmin+zmax)*0.5);
    if (mode != "min" && mode != "center" && mode != "max")
      throw CadError("INVALID_PARAMETER", "Align mode must be min, center or max.");
    feature.NumberParameters["dx"] = targetX - anchor.X();
    feature.NumberParameters["dy"] = targetY - anchor.Y();
    feature.NumberParameters["dz"] = targetZ - anchor.Z();
    gp_Trsf transform; transform.SetTranslation(gp_Vec(feature.NumberParameters["dx"], feature.NumberParameters["dy"], feature.NumberParameters["dz"]));
    BRepBuilderAPI_Transform builder(body.Shape, transform, true); builder.Build();
    if (!builder.IsDone()) throw CadError("BUILD_FAILED", "OCCT could not align the body.");
    result = builder.Shape();
    outputNames=TopologyNaming::Propagate(body.Shape,body.Names,result,builder);
    ShapeSerializer prior(body.Shape,body.TopologyRevision,body.Id),next(result,myRevision+1,body.Id);
    operationRemap=TopologyHistory::Build(prior,next,body.TopologyRevision,myRevision+1,builder);
  }
  else throw CadError("UNKNOWN_OPERATION", "Unsupported advanced transform: " + operation);

  if (result.IsNull() || !BRepCheck_Analyzer(result).IsValid())
    throw CadError("INVALID_RESULT", "The transformed body is not valid.");
  ++myRevision; feature.ComputedRevision = myRevision;

  if (operation == "transform.copy")
  {
    BodyRecord copy;
    copy.Id = nextBodyId(); copy.SourceFeatureId = feature.Id; copy.Shape = result;
    copy.Names=outputNames;
    for(auto& [unused,origins]:copy.Names)for(auto& origin:origins)origin=feature.Id+"/copy/"+origin;
    copy.Label = myShapeTool->AddShape(result, false, false); copy.TopologyRevision = myRevision;
    copy.Name = body.Name + " Copy"; copy.Color = body.Color; copy.Material = body.Material; copy.Kind = body.Kind;
    copy.Opacity=body.Opacity;
    feature.StringParameters["sourceBody"] = body.Id; feature.OutputBodies = {copy.Id};
    StoreBodyDisplayMetadata(feature,"outputBodyMeta",copy);
    feature.RecordTopologyLineage(body.Id,body.TopologyRevision,copy.Id,myRevision,operationRemap,true);
    myActiveBodyId = copy.Id; myBodies.emplace(copy.Id, copy); myFeatures.push_back(feature); persistMetadata();
    return ShapeSerializer(result, myRevision, copy.Id).Serialize(responsePrefix(requestId));
  }

  ShapeSerializer oldTopology(body.Shape, body.TopologyRevision, body.Id);
  ShapeSerializer nextTopology(result, myRevision, body.Id);
  myProperties.RemapTopology(body.Id,body.Id,operationRemap,operation);
  feature.RecordTopologyLineage(body.Id,body.TopologyRevision,body.Id,myRevision,operationRemap);
  feature.OutputBodies = {body.Id}; body.Shape = result; body.SourceFeatureId = feature.Id; body.Names=std::move(outputNames);
  body.TopologyRevision = myRevision; myShapeTool->SetShape(body.Label, result);
  myActiveBodyId = body.Id; myFeatures.push_back(feature); persistMetadata();
  return nextTopology.Serialize(responsePrefix(requestId));
}
}
