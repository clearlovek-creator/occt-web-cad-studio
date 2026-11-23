#include "CadDocument.hxx"
#include "CadError.hxx"
#include "CoordinateReference.hxx"
#include "../features/PrimitiveBuilder.hxx"
#include "../presentation/ShapeSerializer.hxx"
#include <algorithm>
#include <cctype>

namespace occweb
{
std::string CadDocument::CreatePrimitive(const std::string& requestId,
                                         const std::string& operation,
                                         const JsonValue& parameters)
{
  if (parameters.GetBooleanOr("reset", false)) initializeDocument();

  FeatureNode feature;
  feature.Id = nextFeatureId();
  feature.Type = operation;
  const double x = parameterValue(parameters, "x", "length", 0.0, false, &feature);
  const double y = parameterValue(parameters, "y", "length", 0.0, false, &feature);
  const double z = parameterValue(parameters, "z", "length", 0.0, false, &feature);
  const std::string coordinateSystemId = parameters.GetStringOr("coordinateSystemId", "global");
  feature.StringParameters["coordinateSystemId"] = coordinateSystemId;
  if (parameters.Has("coordinatePlane"))
    feature.StringParameters["coordinatePlane"] = parameters.GetString("coordinatePlane");
  ApplyFeatureCoordinates(feature,myCoordinateSystems);
  const std::map<std::string,std::vector<std::string>> fields = {
    {"primitive.box",{"width","depth","height"}}, {"primitive.cylinder",{"radius","height"}},
    {"primitive.cone",{"radius1","radius2","height"}}, {"primitive.sphere",{"radius"}},
    {"primitive.torus",{"majorRadius","minorRadius"}}, {"primitive.wedge",{"width","depth","height"}},
    {"primitive.prism",{"radius","height"}}, {"primitive.pyramid",{"baseWidth","baseDepth","height"}},
    {"primitive.tube",{"outerRadius","innerRadius","height"}}, {"surface.rectangle",{"width","height"}},
    {"surface.disk",{"radius"}}, {"surface.cylinder",{"radius","height"}},
    {"surface.cone",{"radius1","radius2","height"}}, {"surface.sphere",{"radius"}}
  };
  const auto found=fields.find(operation);
  if(found==fields.end())throw CadError("UNKNOWN_OPERATION","Unsupported primitive: "+operation);
  for(const auto& key:found->second)parameterValue(parameters,key,"length",0,true,&feature);
  if(operation=="primitive.wedge")parameterValue(parameters,"topLength","length",feature.NumberParameters.at("width")*.5,false,&feature);
  if(operation=="primitive.prism")parameterValue(parameters,"sides","integer",6,false,&feature);
  if(operation=="primitive.pyramid") {
    parameterValue(parameters,"topWidth","length",std::max(feature.NumberParameters.at("baseWidth")*.01,.01),false,&feature);
    parameterValue(parameters,"topDepth","length",std::max(feature.NumberParameters.at("baseDepth")*.01,.01),false,&feature);
  }
  const auto built=BuildNamedPrimitive(feature);
  const TopoDS_Shape& shape=built.Shape;
  ++myRevision;
  feature.ComputedRevision = myRevision;

  BodyRecord body;
  body.Id = nextBodyId();
  body.SourceFeatureId = feature.Id;
  body.Shape = shape;
  body.Names = built.Names;
  body.Kind = BodyKindFromShape(shape);
  body.Label = myShapeTool->AddShape(shape, false, false);
  body.TopologyRevision = myRevision;
  const std::string typeName = operation.substr(operation.find('.') + 1);
  body.Name = std::string(1, static_cast<char>(std::toupper(static_cast<unsigned char>(typeName[0])))) + typeName.substr(1)
            + body.Id.substr(body.Id.find('-') + 1);
  feature.OutputBodies.push_back(body.Id);
  myActiveBodyId = body.Id;
  myBodies.emplace(body.Id, body);
  myFeatures.push_back(feature);
  persistMetadata();
  return ShapeSerializer(shape, myRevision, body.Id).Serialize(responsePrefix(requestId));
}
}
