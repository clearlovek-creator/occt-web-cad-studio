#include "CadDocument.hxx"

#include "CadError.hxx"
#include "BodyDisplayMetadata.hxx"
#include "ShapeSpatial.hxx"
#include "../presentation/ShapeSerializer.hxx"
#include "TopologyHistory.hxx"
#include "../features/PrimitiveBuilder.hxx"
#include "../features/EdgeDetailLimits.hxx"
#include "../protocol/Json.hxx"

#include <BinXCAFDrivers.hxx>
#include <BRepCheck_Analyzer.hxx>
#include <BRepBndLib.hxx>
#include <BRepGProp.hxx>
#include <GProp_GProps.hxx>
#include <Bnd_Box.hxx>
#include <BRepAlgoAPI_Common.hxx>
#include <BRepAlgoAPI_Cut.hxx>
#include <BRepAlgoAPI_Fuse.hxx>
#include <BRepFilletAPI_MakeFillet.hxx>
#include <BRepFilletAPI_MakeChamfer.hxx>
#include <BRepPrimAPI_MakeBox.hxx>
#include <PCDM_ReaderStatus.hxx>
#include <PCDM_StoreStatus.hxx>
#include <TCollection_AsciiString.hxx>
#include <TCollection_ExtendedString.hxx>
#include <TDataStd_NamedData.hxx>
#include <TDF_ChildIterator.hxx>
#include <NCollection_Sequence.hxx>
#include <TDocStd_Application.hxx>
#include <XCAFApp_Application.hxx>
#include <XCAFDoc_DocumentTool.hxx>
#include <TopoDS.hxx>
#include <gp_Pnt.hxx>
#include <TopAbs_ShapeEnum.hxx>
#include <TopExp_Explorer.hxx>

#include <algorithm>
#include <cmath>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <limits>
#include <sstream>

namespace
{
const TCollection_ExtendedString KEY_REVISION("system.revision");
const TCollection_ExtendedString KEY_ACTIVE_BODY("system.activeBody");
const TCollection_ExtendedString KEY_FEATURES("system.features");
const TCollection_ExtendedString KEY_IDENTITIES("system.entityIdentities.v1");
const TCollection_ExtendedString KEY_PROPERTIES("system.userProperties");
const TCollection_ExtendedString KEY_VARIABLES("system.scalarVariables");
const TCollection_ExtendedString KEY_COORDINATE_SYSTEMS("system.coordinateSystems");
const TCollection_ExtendedString KEY_MATERIALS("system.materials");
const TCollection_ExtendedString KEY_BODY_ID("system.bodyId");
const TCollection_ExtendedString KEY_SOURCE_FEATURE("system.sourceFeature");
const TCollection_ExtendedString KEY_TOPOLOGY_REVISION("system.topologyRevision");
const TCollection_ExtendedString KEY_TOPOLOGY_NAMES("system.topologyNames.v1");
const TCollection_ExtendedString KEY_BODY_NAME("system.bodyName");
const TCollection_ExtendedString KEY_BODY_VISIBLE("system.bodyVisible");
const TCollection_ExtendedString KEY_BODY_COLOR("system.bodyColor");
const TCollection_ExtendedString KEY_BODY_MATERIAL("system.bodyMaterial");
const TCollection_ExtendedString KEY_BODY_OPACITY("system.bodyOpacity.v1");
const TCollection_ExtendedString KEY_BODY_KIND("system.bodyKind");

std::string toUtf8(const TCollection_ExtendedString& value)
{
  std::string result(static_cast<std::size_t>(value.LengthOfCString()) + 1, '\0');
  char* buffer = result.data();
  const int length = value.ToUTF8CString(buffer);
  result.resize(static_cast<std::size_t>(length));
  return result;
}

TCollection_ExtendedString fromUtf8(const std::string& value)
{
  return TCollection_ExtendedString(value.c_str(), true);
}

std::vector<TopoDS_Shape> solidShapes(const TopoDS_Shape& shape)
{
  std::vector<TopoDS_Shape> solids;
  for (TopExp_Explorer explorer(shape, TopAbs_SOLID); explorer.More(); explorer.Next())
    solids.push_back(explorer.Current());
  return solids;
}

Handle(TDocStd_Application) application()
{
  Handle(TDocStd_Application) app = XCAFApp_Application::GetApplication();
  static bool formatDefined = false;
  if (!formatDefined)
  {
    BinXCAFDrivers::DefineFormat(app);
    formatDefined = true;
  }
  return app;
}
void closeRegisteredDocument(const Handle(TDocStd_Document)& document)
{
  if(document.IsNull())return;
  const auto app=application();
  for(int index=1;index<=app->NbDocuments();++index)
    if(app->GetDocument(index)==document){app->Close(document);return;}
}
struct FailedOpenCleanup
{
  std::vector<Handle(TDocStd_Document)> Before;
  bool Committed=false;
  FailedOpenCleanup(){const auto app=application();for(int i=1;i<=app->NbDocuments();++i)Before.push_back(app->GetDocument(i));}
  ~FailedOpenCleanup(){if(Committed)return;try{const auto app=application();for(int i=app->NbDocuments();i>=1;--i){const auto document=app->GetDocument(i);if(std::find(Before.begin(),Before.end(),document)==Before.end())app->Close(document);}}catch(...){}}
};
}

namespace occweb
{
std::string BodyKindFromShape(const TopoDS_Shape& shape)
{
  if (shape.IsNull()) return "shape";
  if (TopExp_Explorer(shape, TopAbs_SOLID).More()) return "solid";
  if (TopExp_Explorer(shape, TopAbs_FACE).More()) return "sheet";
  if (TopExp_Explorer(shape, TopAbs_EDGE).More()) return "wire";
  return "shape";
}

CadDocument::CadDocument(std::string documentId) : myDocumentId(std::move(documentId))
{
  initializeDocument();
}
CadDocument::~CadDocument() noexcept
{
  try{closeRegisteredDocument(myDocument);}catch(...){ }
}

std::string CadDocument::Reset(const std::string& requestId)
{
  initializeDocument();
  return Summary(requestId);
}

void CadDocument::swapState(CadDocument& other) noexcept
{
  using std::swap;
  swap(myRevision,other.myRevision);swap(myNextBody,other.myNextBody);swap(myNextFeature,other.myNextFeature);
  swap(myActiveBodyId,other.myActiveBodyId);swap(myDocument,other.myDocument);swap(myShapeTool,other.myShapeTool);
  swap(myBodies,other.myBodies);swap(myEntityIdentities,other.myEntityIdentities);swap(myFeatures,other.myFeatures);
  swap(myProperties,other.myProperties);swap(myVariables,other.myVariables);swap(myCoordinateSystems,other.myCoordinateSystems);swap(myMaterials,other.myMaterials);
}

void CadDocument::initializeDocument() {
  Handle(TDocStd_Document) next;
  application()->NewDocument("BinXCAF", next);
  if (next.IsNull()) throw CadError("DOCUMENT_CREATE_FAILED", "Could not create XCAF document.");
  closeRegisteredDocument(myDocument);
  myDocument=next;
  myShapeTool = XCAFDoc_DocumentTool::ShapeTool(myDocument->Main());
  myBodies.clear();
  myEntityIdentities.clear();
  myFeatures.clear();
  myProperties.Clear();
  myVariables.Clear();
  myCoordinateSystems.Clear();
  myMaterials.ResetDefaults();
  myActiveBodyId.clear();
  myRevision = 0;
  myNextBody = 1;
  myNextFeature = 1;
}

std::string CadDocument::nextBodyId()
{
  while (true)
  {
    const std::string candidate = "body-" + std::to_string(myNextBody++);
    if (myBodies.find(candidate) == myBodies.end() && !myEntityIdentities.count(candidate)) {
      myEntityIdentities.emplace(candidate,EntityIdentity{newIdentity(),"",-1});
      return candidate;
    }
  }
}

std::string CadDocument::nextFeatureId()
{
  while (true)
  {
    const std::string candidate = "feature-" + std::to_string(myNextFeature++);
    const auto found = std::find_if(myFeatures.begin(), myFeatures.end(),
      [&](const FeatureNode& feature) { return feature.Id == candidate; });
    if (found == myFeatures.end()) return candidate;
  }
}

std::string CadDocument::featuresJson(bool includeInternal) const
{
  std::ostringstream out;
  out << '[';
  for (std::size_t i = 0; i < myFeatures.size(); ++i)
  {
    if (i > 0) out << ',';
    out << myFeatures[i].ToJson(includeInternal);
  }
  out << ']';
  return out.str();
}

std::string CadDocument::responsePrefix(const std::string& requestId) const
{
  std::ostringstream out;
  out << "{\"ok\":true,\"protocolVersion\":1,\"requestId\":\"" << JsonEscape(requestId)
      << "\",\"documentId\":\"" << JsonEscape(myDocumentId)
      << "\",\"revision\":" << myRevision
      << ",\"spatialPolicy\":" << SpatialPolicyJson()
      << ",\"bodyCount\":" << myBodies.size()
      << ",\"featureCount\":" << myFeatures.size()
      << ",\"features\":" << featuresJson()
      << ",\"variables\":" << myVariables.ToJson()
      << ",\"coordinateSystems\":" << myCoordinateSystems.ToJson()
      << ",\"materials\":" << myMaterials.ToJson()
      << ",\"entityIdentities\":" << identitiesJson()
      << ",\"bodyMetadata\":" << bodyMetadataJson();
  return out.str();
}

std::string CadDocument::bodyMetadataJson() const
{
  std::ostringstream out;
  out << '[';
  bool first = true;
  for (const auto& [id, body] : myBodies)
  {
    if (!first) out << ',';
    if(!body.SpatialCache || body.SpatialCache->Kind!=body.Kind || !body.SpatialCache->Shape.IsEqual(body.Shape))
      body.SpatialCache=BuildSpatialMetadata(body.Shape,body.Kind);
    out << "{\"bodyId\":\"" << JsonEscape(id) << "\",\"topologyRevision\":" << body.TopologyRevision << ",\"name\":\"" << JsonEscape(body.Name)
        << "\",\"visible\":" << (body.Visible ? "true" : "false")
        << ",\"color\":\"" << JsonEscape(body.Color) << "\",\"material\":\"" << JsonEscape(body.Material)
        << "\",\"opacity\":" << std::setprecision(std::numeric_limits<double>::max_digits10) << body.Opacity
        << ",\"kind\":\"" << JsonEscape(body.Kind) << "\""
        << bodyIdentityJson(id)
        << ",\"topologyNaming\":" << TopologyNaming::CoverageJson(body.Names)
        << body.SpatialCache->Fields << "}";
    first = false;
  }
  out << ']';
  return out.str();
}
std::string CadDocument::CreateBox(const std::string& requestId, const double width,
                                   const double depth, const double height, const bool reset)
{
  const auto valid = [](double value) { return std::isfinite(value) && value > 0.0 && value <= 10000.0; };
  if (!valid(width) || !valid(depth) || !valid(height))
    throw CadError("INVALID_PARAMETER", "Box dimensions must be between 0 and 10000 mm.");
  if (reset) initializeDocument();

  FeatureNode feature;
  feature.Id = nextFeatureId();
  feature.Type = "primitive.box";
  feature.NumberParameters = {{"width", width}, {"depth", depth}, {"height", height}};
  const auto built=BuildNamedPrimitive(feature);
  const auto& shape=built.Shape;
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
  body.Name = "Box" + body.Id.substr(body.Id.find('-') + 1);
  feature.OutputBodies.push_back(body.Id);
  myActiveBodyId = body.Id;
  myBodies.emplace(body.Id, body);
  myFeatures.push_back(feature);
  persistMetadata();

  return ShapeSerializer(shape, myRevision, body.Id).Serialize(responsePrefix(requestId));
}

const BodyRecord& CadDocument::bodyOrActive(const std::string& bodyId) const
{
  const std::string& resolved = bodyId.empty() ? myActiveBodyId : bodyId;
  const auto found = myBodies.find(resolved);
  if (found == myBodies.end()) throw CadError("BODY_NOT_FOUND", "The selected body does not exist.");
  return found->second;
}

BodyRecord& CadDocument::bodyOrActive(const std::string& bodyId)
{
  return const_cast<BodyRecord&>(std::as_const(*this).bodyOrActive(bodyId));
}

std::string CadDocument::Fillet(const std::string& requestId, const int expectedRevision,
                                const std::string& bodyId, const std::string& edgeId,
                                const double radius)
{
  if (expectedRevision != myRevision)
    throw CadError("STALE_REVISION", "Model revision is stale. Reload the current model and select the edge again.");
  if (!std::isfinite(radius) || radius <= 0.0 || radius > 1000.0)
    throw CadError("INVALID_PARAMETER", "Fillet radius must be between 0 and 1000 mm.");

  BodyRecord& body = bodyOrActive(bodyId);
  // Feasibility depends on the selected edge's adjacent geometry. A thin
  // plate's thickness does not limit a fillet around its vertical corner.
  // Let OCCT build it and validate the actual result before changing state.
  ShapeSerializer current(body.Shape, body.TopologyRevision, body.Id);
  const int edgeIndex = current.EdgeIndexFromId(edgeId);
  if (edgeIndex < 1 || edgeIndex > current.Edges().Extent())
    throw CadError("EDGE_NOT_FOUND", "The selected edge does not exist in this model revision.");

  ValidatePlanarEdgeDetail(body.Shape,TopoDS::Edge(current.Edges()(edgeIndex)),radius,true);
  BRepFilletAPI_MakeFillet builder(body.Shape);
  builder.Add(radius, TopoDS::Edge(current.Edges()(edgeIndex)));
  builder.Build();
  if (!builder.IsDone()) throw CadError("BUILD_FAILED", "OCCT could not build this fillet. Try a smaller radius.");
  const TopoDS_Shape result = builder.Shape();
  if (result.IsNull() || !BRepCheck_Analyzer(result).IsValid())
    throw CadError("INVALID_RESULT", "The fillet result is not a valid solid.");

  ++myRevision;
  ShapeSerializer nextTopology(result, myRevision, body.Id);
  const TopologyRemap remap = TopologyHistory::Build(current, nextTopology,
                                                      body.TopologyRevision, myRevision, builder,
                                                      {edgeId});
  myProperties.RemapTopology(body.Id, body.Id, remap, "detail.fillet");
  FeatureNode feature;
  feature.Id = nextFeatureId();
  feature.Type = "detail.fillet";
  feature.ComputedRevision = myRevision;
  feature.InputFeatures.push_back(body.SourceFeatureId);
  feature.OutputBodies.push_back(body.Id);
  feature.NumberParameters["radius"] = radius;
  feature.StringParameters["edgeId"] = edgeId;
  feature.StringParameters["selection.edgeId"] = TopologyNaming::CaptureSelection(body.Shape, body.Names, "edge", edgeIndex);
  feature.RecordTopologyLineage(body.Id,body.TopologyRevision,body.Id,myRevision,remap);
  body.Names=TopologyNaming::FeatureResult(body.Shape,body.Names,result,builder,feature.Id);
  body.Shape = result;
  body.SourceFeatureId = feature.Id;
  body.TopologyRevision = myRevision;
  myShapeTool->SetShape(body.Label, result);
  myActiveBodyId = body.Id;
  myFeatures.push_back(feature);
  persistMetadata();
  return nextTopology.Serialize(responsePrefix(requestId));
}

std::string CadDocument::Chamfer(const std::string& requestId, const int expectedRevision,
                                 const std::string& bodyId, const std::string& edgeId,
                                 const double distance)
{
  if (expectedRevision != myRevision)
    throw CadError("STALE_REVISION", "Model revision is stale. Reload the current model and select the edge again.");
  if (!std::isfinite(distance) || distance <= 0.0 || distance > 1000.0)
    throw CadError("INVALID_PARAMETER", "Chamfer distance must be between 0 and 1000 mm.");

  BodyRecord& body = bodyOrActive(bodyId);
  // A global minimum bounding-box span is not a chamfer feasibility test.
  ShapeSerializer current(body.Shape, body.TopologyRevision, body.Id);
  const int edgeIndex = current.EdgeIndexFromId(edgeId);
  if (edgeIndex < 1 || edgeIndex > current.Edges().Extent())
    throw CadError("EDGE_NOT_FOUND", "The selected edge does not exist in this model revision.");

  ValidatePlanarEdgeDetail(body.Shape,TopoDS::Edge(current.Edges()(edgeIndex)),distance,false);
  BRepFilletAPI_MakeChamfer builder(body.Shape);
  builder.Add(distance, TopoDS::Edge(current.Edges()(edgeIndex)));
  builder.Build();
  if (!builder.IsDone()) throw CadError("BUILD_FAILED", "OCCT could not build this chamfer. Try a smaller distance.");
  const TopoDS_Shape result = builder.Shape();
  if (result.IsNull() || !BRepCheck_Analyzer(result).IsValid())
    throw CadError("INVALID_RESULT", "The chamfer result is not a valid solid.");

  ++myRevision;
  ShapeSerializer nextTopology(result, myRevision, body.Id);
  const TopologyRemap remap = TopologyHistory::Build(current, nextTopology,
                                                      body.TopologyRevision, myRevision, builder,
                                                      {edgeId});
  myProperties.RemapTopology(body.Id, body.Id, remap, "detail.chamfer");
  FeatureNode feature;
  feature.Id = nextFeatureId();
  feature.Type = "detail.chamfer";
  feature.ComputedRevision = myRevision;
  feature.InputFeatures.push_back(body.SourceFeatureId);
  feature.OutputBodies.push_back(body.Id);
  feature.NumberParameters["distance"] = distance;
  feature.StringParameters["edgeId"] = edgeId;
  feature.StringParameters["selection.edgeId"] = TopologyNaming::CaptureSelection(body.Shape, body.Names, "edge", edgeIndex);
  feature.RecordTopologyLineage(body.Id,body.TopologyRevision,body.Id,myRevision,remap);
  body.Names=TopologyNaming::FeatureResult(body.Shape,body.Names,result,builder,feature.Id);
  body.Shape = result;
  body.SourceFeatureId = feature.Id;
  body.TopologyRevision = myRevision;
  myShapeTool->SetShape(body.Label, result);
  myActiveBodyId = body.Id;
  myFeatures.push_back(feature);
  persistMetadata();
  return nextTopology.Serialize(responsePrefix(requestId));
}
std::string CadDocument::Summary(const std::string& requestId) const
{
  std::ostringstream out;
  out << responsePrefix(requestId)
      << ",\"activeBodyId\":\"" << JsonEscape(myActiveBodyId) << "\",\"bodies\":[";
  bool first = true;
  for (const auto& [id, body] : myBodies)
  {
    if (!first) out << ',';
    ShapeSerializer topology(body.Shape, body.TopologyRevision, body.Id);
    out << "{\"id\":\"" << JsonEscape(id) << "\",\"sourceFeatureId\":\""
        << JsonEscape(body.SourceFeatureId) << "\",\"topologyRevision\":" << body.TopologyRevision
        << ",\"name\":\"" << JsonEscape(body.Name) << "\",\"visible\":" << (body.Visible ? "true" : "false")
        << ",\"color\":\"" << JsonEscape(body.Color) << "\",\"material\":\"" << JsonEscape(body.Material)
        << "\",\"opacity\":" << std::setprecision(std::numeric_limits<double>::max_digits10) << body.Opacity
        << ",\"kind\":\"" << JsonEscape(body.Kind) << "\",\"faceCount\":" << topology.Faces().Extent()
        << ",\"edgeCount\":" << topology.Edges().Extent() << bodyIdentityJson(id) << ",\"topologyNaming\":" << TopologyNaming::CoverageJson(body.Names) << '}';
    first = false;
  }
  out << "],\"propertyRecords\":" << myProperties.ToJson() << ",\"presentationMode\":\"metadata\",\"stats\":{\"faceCount\":0,\"edgeCount\":0,\"triangleCount\":0}}";
  return out.str();
}

void CadDocument::persistMetadata()
{
  synchronizeIdentities();
  const Handle(TDataStd_NamedData) documentData = TDataStd_NamedData::Set(myDocument->Main());
  documentData->SetString(KEY_IDENTITIES,fromUtf8(identitiesJson()));
  documentData->SetInteger(KEY_REVISION, myRevision);
  documentData->SetString(KEY_ACTIVE_BODY, fromUtf8(myActiveBodyId));
  documentData->SetString(KEY_FEATURES, fromUtf8(featuresJson(true)));
  documentData->SetString(KEY_PROPERTIES, fromUtf8(myProperties.ToJson()));
  documentData->SetString(KEY_VARIABLES, fromUtf8(myVariables.ToJson()));
  documentData->SetString(KEY_COORDINATE_SYSTEMS, fromUtf8(myCoordinateSystems.ToJson(true)));
  documentData->SetString(KEY_MATERIALS, fromUtf8(myMaterials.ToJson()));
  for (const auto& [id, body] : myBodies)
  {
    const Handle(TDataStd_NamedData) bodyData = TDataStd_NamedData::Set(body.Label);
    bodyData->SetString(KEY_BODY_ID, fromUtf8(id));
    bodyData->SetString(KEY_SOURCE_FEATURE, fromUtf8(body.SourceFeatureId));
    bodyData->SetInteger(KEY_TOPOLOGY_REVISION, body.TopologyRevision);
    bodyData->SetString(KEY_TOPOLOGY_NAMES,fromUtf8(TopologyNaming::ToJson(body.Names)));
    bodyData->SetString(KEY_BODY_NAME, fromUtf8(body.Name));
    bodyData->SetInteger(KEY_BODY_VISIBLE, body.Visible ? 1 : 0);
    bodyData->SetString(KEY_BODY_COLOR, fromUtf8(body.Color));
    bodyData->SetString(KEY_BODY_MATERIAL, fromUtf8(body.Material));
    bodyData->SetReal(KEY_BODY_OPACITY,ValidatedBodyOpacity(body.Opacity));
    bodyData->SetString(KEY_BODY_KIND, fromUtf8(body.Kind));
  }
}

std::string CadDocument::SaveSnapshot(const std::string& requestId, const std::string& path)
{
  persistMetadata();
  std::filesystem::create_directories(std::filesystem::path(path).parent_path());
  TCollection_ExtendedString statusMessage;
  const PCDM_StoreStatus status = application()->SaveAs(myDocument, fromUtf8(path), statusMessage);
  if (status != PCDM_SS_OK)
    throw CadError("SNAPSHOT_SAVE_FAILED", "Could not save the XBF document snapshot (status "
                   + std::to_string(static_cast<int>(status)) + "): " + toUtf8(statusMessage));
  return responsePrefix(requestId) + ",\"path\":\"" + JsonEscape(path) + "\"}";
}

void CadDocument::rebuildFromDocument()
{
  myBodies.clear();
  myEntityIdentities.clear();
  myFeatures.clear();
  myProperties.Clear();
  myVariables.Clear();
  myCoordinateSystems.Clear();
  myMaterials.ResetDefaults();
  myShapeTool = XCAFDoc_DocumentTool::ShapeTool(myDocument->Main());
  const Handle(TDataStd_NamedData) data = TDataStd_NamedData::Set(myDocument->Main());
  if(data->HasString(KEY_IDENTITIES)) {
    const auto identities=JsonParser(toUtf8(data->GetString(KEY_IDENTITIES))).Parse();
    for(const auto& [id,value]:identities.AsObject())myEntityIdentities.emplace(id,EntityIdentity{value.GetString("bodyIdentity"),value.GetString("topologyIdentity"),value.GetIntegerOr("topologyRevision",-1)});
  }
  myRevision = data->HasInteger(KEY_REVISION) ? data->GetInteger(KEY_REVISION) : 0;
  myActiveBodyId = data->HasString(KEY_ACTIVE_BODY) ? toUtf8(data->GetString(KEY_ACTIVE_BODY)) : "";
  if (data->HasString(KEY_PROPERTIES))
    myProperties.FromJson(JsonParser(toUtf8(data->GetString(KEY_PROPERTIES))).Parse());
  if (data->HasString(KEY_VARIABLES))
    myVariables.FromJson(JsonParser(toUtf8(data->GetString(KEY_VARIABLES))).Parse());
  if (data->HasString(KEY_COORDINATE_SYSTEMS))
    myCoordinateSystems.FromJson(JsonParser(toUtf8(data->GetString(KEY_COORDINATE_SYSTEMS))).Parse());
  if (data->HasString(KEY_MATERIALS))
    myMaterials.FromJson(JsonParser(toUtf8(data->GetString(KEY_MATERIALS))).Parse());
  myMaterials.ResolveExpressions(myVariables);
  if (data->HasString(KEY_FEATURES))
  {
    const JsonValue root = JsonParser(toUtf8(data->GetString(KEY_FEATURES))).Parse();
    for (const JsonValue& item : root.AsArray()) myFeatures.push_back(FeatureNode::FromJson(item));
  }

  NCollection_Sequence<TDF_Label> labels;
  for (TDF_ChildIterator iterator(myDocument->Main(), Standard_True);
       iterator.More(); iterator.Next())
  {
    const TDF_Label label = iterator.Value();
    Handle(TDataStd_NamedData) bodyData;
    if (label.FindAttribute(TDataStd_NamedData::GetID(), bodyData)
        && bodyData->HasString(KEY_BODY_ID))
      labels.Append(label);
  }
  if (labels.IsEmpty()) myShapeTool->GetFreeShapes(labels);
  int fallback = 1;
  for (const TDF_Label& label : labels)
  {
    const Handle(TDataStd_NamedData) bodyData = TDataStd_NamedData::Set(label);
    BodyRecord body;
    body.Id = bodyData->HasString(KEY_BODY_ID) ? toUtf8(bodyData->GetString(KEY_BODY_ID))
                                               : "body-" + std::to_string(fallback);
    body.SourceFeatureId = bodyData->HasString(KEY_SOURCE_FEATURE)
                         ? toUtf8(bodyData->GetString(KEY_SOURCE_FEATURE)) : "";
    body.Shape = XCAFDoc_ShapeTool::GetShape(label);
    if(bodyData->HasString(KEY_TOPOLOGY_NAMES))body.Names=TopologyNaming::FromJson(JsonParser(toUtf8(bodyData->GetString(KEY_TOPOLOGY_NAMES))).Parse());
    body.Label = label;
    body.TopologyRevision = bodyData->HasInteger(KEY_TOPOLOGY_REVISION)
                            ? bodyData->GetInteger(KEY_TOPOLOGY_REVISION) : myRevision;
    body.Name = bodyData->HasString(KEY_BODY_NAME) ? toUtf8(bodyData->GetString(KEY_BODY_NAME)) : body.Id;
    body.Visible = !bodyData->HasInteger(KEY_BODY_VISIBLE) || bodyData->GetInteger(KEY_BODY_VISIBLE) != 0;
    body.Color = bodyData->HasString(KEY_BODY_COLOR) ? toUtf8(bodyData->GetString(KEY_BODY_COLOR)) : "#7b91aa";
    body.Material = bodyData->HasString(KEY_BODY_MATERIAL) ? toUtf8(bodyData->GetString(KEY_BODY_MATERIAL)) : "";
    if(bodyData->HasString(KEY_BODY_OPACITY)||bodyData->HasInteger(KEY_BODY_OPACITY)||bodyData->HasByte(KEY_BODY_OPACITY)
        ||bodyData->HasArrayOfIntegers(KEY_BODY_OPACITY)||bodyData->HasArrayOfReals(KEY_BODY_OPACITY))
      throw CadError("INVALID_BODY_OPACITY","Stored Body opacity must use the versioned real-valued field.");
    if(bodyData->HasReal(KEY_BODY_OPACITY))body.Opacity=ValidatedBodyOpacity(bodyData->GetReal(KEY_BODY_OPACITY));
    else{
      // Older files omitted the label value but body.update retained evidence
      // on its exact current producer. Never borrow another Body/history slot.
      const auto owner=std::find_if(myFeatures.begin(),myFeatures.end(),[&](const FeatureNode& feature){return feature.Id==body.SourceFeatureId
        &&std::find(feature.OutputBodies.begin(),feature.OutputBodies.end(),body.Id)!=feature.OutputBodies.end();});
      if(owner!=myFeatures.end())if(const auto opacity=StoredBodyOpacity(*owner,"outputBodyMeta",body.Id))body.Opacity=*opacity;
    }
    body.Kind = bodyData->HasString(KEY_BODY_KIND) ? toUtf8(bodyData->GetString(KEY_BODY_KIND)) : BodyKindFromShape(body.Shape);
    myBodies.emplace(body.Id, body);
    ++fallback;
  }
  myNextBody = fallback;

  // Migrate documents created before STEP assemblies were split into Bodies.
  // Their XBF still contains the original compound and one body metadata row.
  for (FeatureNode& feature : myFeatures)
  {
    if (myFeatures.size() != 1 || myBodies.size() != 1 || feature.Type != "import.step"
        || feature.NumberParameters.count("decompositionVersion") || feature.OutputBodies.size() != 1) continue;
    const auto existing = myBodies.find(feature.OutputBodies.front());
    if (existing == myBodies.end()) continue;
    const BodyRecord prototype = existing->second;
    const std::vector<TopoDS_Shape> solids = solidShapes(prototype.Shape);
    if (solids.size() <= 1) continue;

    myShapeTool->RemoveShape(prototype.Label, true);
    myBodies.clear();
    feature.OutputBodies.clear();
    myNextBody = 1;
    for (const TopoDS_Shape& solid : solids)
    {
      BodyRecord body = prototype;
      body.Id = nextBodyId();
      body.Name = body.Id;
      body.Shape = solid;
      body.Names.clear();
      body.Label = myShapeTool->AddShape(solid, false, false);
      feature.OutputBodies.push_back(body.Id);
      myBodies.emplace(body.Id, body);
    }
    if (!feature.OutputBodies.empty()) myActiveBodyId = feature.OutputBodies.front();
    persistMetadata();
    break;
  }

  myNextBody = std::max(myNextBody, static_cast<int>(myBodies.size()) + 1);
  myNextFeature = static_cast<int>(myFeatures.size()) + 1;
  if (myActiveBodyId.empty() && !myBodies.empty()) myActiveBodyId = myBodies.begin()->first;
  // Legacy snapshots have no identity evidence: allocate new identities, never
  // infer an old property's identity from a matching display number.
  persistMetadata();
}

void CadDocument::loadSnapshot(std::istream& input)
{
  FailedOpenCleanup cleanup;
  Handle(TDocStd_Document) loaded;
  // A stream load creates an independent document even when the same file is
  // already registered in this OCCT application. Never close a live owner first.
  if (application()->Open(input, loaded) != PCDM_RS_OK || loaded.IsNull())
    throw CadError("SNAPSHOT_OPEN_FAILED", "Could not open the XBF document snapshot.");
  closeRegisteredDocument(myDocument);
  myDocument = loaded;
  rebuildFromDocument();
  cleanup.Committed=true;
}

std::string CadDocument::ImportStep(const std::string& requestId, const std::string& path,
                                    const std::string& currentCheckpoint)
{
  CadDocument staged(myDocumentId);
  if (!currentCheckpoint.empty())
  {
    std::ifstream input(std::filesystem::u8path(currentCheckpoint), std::ios::binary);
    if (!input) throw CadError("SNAPSHOT_OPEN_FAILED", "Could not read the STEP append checkpoint.");
    staged.loadSnapshot(input);
  }
  else
  {
    // Direct callers do not have the Worker's transaction checkpoint.
    persistMetadata();
    std::stringstream snapshot(std::ios::in | std::ios::out | std::ios::binary);
    if (application()->SaveAs(myDocument, snapshot) != PCDM_SS_OK)
      throw CadError("SNAPSHOT_SAVE_FAILED", "Could not stage the project for STEP append.");
    snapshot.seekg(0);
    staged.loadSnapshot(snapshot);
  }
  staged.myNextBody = myNextBody;
  staged.myNextFeature = myNextFeature;
  const std::string response = staged.importStepStaged(requestId, path);
  swapState(staged);
  return response;
}

std::string CadDocument::RestoreSnapshot(const std::string& requestId, const std::string& path,
                                        const JsonValue& sourceBindings)
{
  std::ifstream input(std::filesystem::u8path(path),std::ios::binary);
  if(!input)throw CadError("SNAPSHOT_OPEN_FAILED","Could not read the XBF document snapshot.");
  CadDocument staged(myDocumentId);
  staged.loadSnapshot(input);
  int bound = 0;
  if (!sourceBindings.IsNull())
  {
    std::map<std::string, std::string> paths;
    for (const JsonValue& binding : sourceBindings.AsArray())
    {
      const std::string featureId = binding.GetString("featureId");
      const std::string sourcePath = binding.GetString("path");
      if (!std::filesystem::is_regular_file(std::filesystem::u8path(sourcePath))
          || !paths.emplace(featureId, sourcePath).second)
        throw CadError("INVALID_SOURCE_BINDING", "A STEP source is missing or duplicated.");
    }
    for (FeatureNode& feature : staged.myFeatures)
    {
      if (feature.Type != "import.step") continue;
      const auto found = paths.find(feature.Id);
      if (found == paths.end())
        throw CadError("INVALID_SOURCE_BINDING", "The project package does not contain every STEP source.");
      feature.StringParameters["sourcePath"] = found->second;
      ++bound;
    }
    if (bound != static_cast<int>(paths.size()))
      throw CadError("INVALID_SOURCE_BINDING", "The package contains a source for an unknown feature.");
    staged.persistMetadata();
  }
  std::string summary = staged.Summary(requestId);
  summary.pop_back();
  summary += ",\"sourceBindingsApplied\":" + std::to_string(bound) + "}";
  swapState(staged);
  return summary;
}
}
