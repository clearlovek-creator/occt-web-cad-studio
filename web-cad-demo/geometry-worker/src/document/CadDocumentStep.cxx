#include "CadDocument.hxx"

#include "CadError.hxx"
#include "ShapeSpatial.hxx"
#include "../presentation/ShapeSerializer.hxx"
#include "../protocol/Json.hxx"
#include "../exchange/StepImport.hxx"

#include <BRepCheck_Analyzer.hxx>
#include <BRepBndLib.hxx>
#include <BRepGProp.hxx>
#include <GProp_GProps.hxx>
#include <BRep_Builder.hxx>
#include <BRepTools.hxx>
#include <IFSelect_ReturnStatus.hxx>
#include <NCollection_Sequence.hxx>
#include <STEPCAFControl_Reader.hxx>
#include <STEPCAFControl_Writer.hxx>
#include <STEPControl_Writer.hxx>
#include <TDF_Label.hxx>
#include <XCAFDoc_DocumentTool.hxx>
#include <XCAFDoc_ColorTool.hxx>
#include <TDataStd_Name.hxx>

#include <filesystem>
#include <fstream>
#include <TopAbs_ShapeEnum.hxx>
#include <TopExp_Explorer.hxx>
#include <vector>
#include <iomanip>

namespace occweb
{
std::string CadDocument::ImportStep(const std::string& requestId, const std::string& path)
{
  CadDocument staged(myDocumentId);
  const std::string response=staged.importStepStaged(requestId,path);
  swapState(staged);
  return response;
}

std::string CadDocument::importStepStaged(const std::string& requestId,const std::string& path)
{
  const std::filesystem::path sourcePath = std::filesystem::absolute(std::filesystem::u8path(path)).lexically_normal();
  const auto imported=ReadStepParts(sourcePath.u8string(),2,"",myDocument);
  XCAFDoc_DocumentTool::SetLengthUnit(myDocument,0.001);

  ++myRevision;
  FeatureNode feature;
  feature.Id = nextFeatureId();
  feature.Type = "import.step";
  feature.ComputedRevision = myRevision;
  feature.StringParameters["fileName"] = sourcePath.filename().u8string();
  feature.StringParameters["sourcePath"] = sourcePath.u8string();
  feature.NumberParameters["decompositionVersion"]=2;
  feature.StringParameters["sourceFingerprint"]=imported.SourceFingerprint;
  feature.StringParameters["sourceFingerprintAlgorithm"]="sha256-chain-1m-v1";
  feature.NumberParameters["importNamingVersion"]=1;
  feature.StringParameters["modelLengthUnit"]="mm";
  const auto colors=XCAFDoc_DocumentTool::ColorTool(myDocument->Main());
  int invalidCount=0,solidCount=0,sheetCount=0,wireCount=0,otherCount=0;
  for (const auto& part : imported.Parts)
  {
    BodyRecord body;
    body.Id = nextBodyId();
    body.SourceFeatureId = feature.Id;
    body.Shape = part.Shape;
    body.Names = TopologyNaming::ImportedSource(part.Shape,feature.Id,body.Id,imported.SourceFingerprint);
    body.Kind = BodyKindFromShape(part.Shape);
    body.Label = part.Label;
    body.Name=part.Name.empty()?"Imported"+body.Id.substr(5):part.Name;
    TDataStd_Name::Set(body.Label,TCollection_ExtendedString(body.Name.c_str(),true));
    if(part.HasColor){body.Color=Quantity_Color::ColorToHex(part.Color).ToCString();colors->SetColor(body.Label,part.Color,XCAFDoc_ColorGen);}
    if(!part.Valid)invalidCount++;
    if(body.Kind=="solid")solidCount++;else if(body.Kind=="sheet")sheetCount++;else if(body.Kind=="wire")wireCount++;else otherCount++;
    body.TopologyRevision = myRevision;
    feature.OutputBodies.push_back(body.Id);
    myActiveBodyId = body.Id;
    myBodies.emplace(body.Id, body);
  }
  if (myBodies.empty()) throw CadError("STEP_EMPTY", "The STEP file contains no usable shapes.");
  myFeatures.push_back(feature);
  persistMetadata();
  std::ostringstream report;report<<",\"stepImport\":{\"version\":1,\"decompositionVersion\":2,\"modelLengthUnit\":\"mm\",\"sourceLengthUnits\":[";
  for(std::size_t index=0;index<imported.LengthUnits.size();index++){if(index)report<<',';report<<'"'<<JsonEscape(imported.LengthUnits[index])<<'"';}
  report<<"],\"rootCount\":"<<imported.RootCount<<",\"emptyRootCount\":"<<imported.EmptyRoots<<",\"bodyCount\":"<<myBodies.size()<<",\"solidCount\":"<<solidCount<<",\"sheetCount\":"<<sheetCount<<",\"wireCount\":"<<wireCount<<",\"otherCount\":"<<otherCount<<",\"invalidBodyCount\":"<<invalidCount<<",\"ambiguousSubshapeMetadata\":"<<imported.AmbiguousSubshapeMetadata<<",\"assemblyHierarchyRetained\":false,\"applicationRepairApplied\":false,\"translatorShapeProcessing\":\"occt-default\"}";
  if(invalidCount||imported.EmptyRoots||imported.AmbiguousSubshapeMetadata)report<<",\"warnings\":[\"STEP imported with diagnostic warnings; inspect geometry validity and metadata before modeling or meshing.\"]";
  return responsePrefix(requestId) + ",\"activeBodyId\":\""+JsonEscape(myActiveBodyId)+"\",\"presentationMode\":\"lazy\""+report.str()+"}";
}

std::string CadDocument::ExportStep(const std::string& requestId, const std::string& path,
                                    const std::string& bodyId,
                                    const std::string& selectionType,
                                    const std::string& topologyId)
{
  if (myBodies.empty()) throw CadError("DOCUMENT_EMPTY", "The document has no bodies to export.");
  std::filesystem::create_directories(std::filesystem::path(path).parent_path());

  if (!bodyId.empty())
  {
    const BodyRecord& body = bodyOrActive(bodyId);
    TopoDS_Shape shape = body.Shape;
    if (!selectionType.empty() && selectionType != "body")
    {
      if (selectionType != "face") throw CadError("INVALID_MESH_SELECTION", "Only body and face selections can be exported for meshing.");
      ShapeSerializer topology(body.Shape, body.TopologyRevision, body.Id);
      const int index = topology.FaceIndexFromId(topologyId);
      if (index < 1 || index > topology.Faces().Extent()) throw CadError("FACE_NOT_FOUND", "The selected Face does not exist.");
      shape = topology.Faces()(index);
    }
    STEPControl_Writer writer;
    if (writer.Transfer(shape, STEPControl_AsIs) != IFSelect_RetDone)
      throw CadError("STEP_TRANSFER_FAILED", "OCCT could not transfer the selected shape to STEP.");
    if (writer.Write(path.c_str()) != IFSelect_RetDone)
      throw CadError("STEP_WRITE_FAILED", "OCCT could not write the selected STEP file.");
    return responsePrefix(requestId) + ",\"path\":\"" + JsonEscape(path)
         + "\",\"selectionType\":\"" + JsonEscape(selectionType.empty() ? "body" : selectionType)
         + "\",\"bodyId\":\"" + JsonEscape(body.Id) + "\"}";
  }

  STEPCAFControl_Writer writer;
  writer.SetColorMode(true);
  writer.SetNameMode(true);
  writer.SetLayerMode(true);
  writer.SetPropsMode(true);
  if (!writer.Transfer(myDocument, STEPControl_AsIs))
    throw CadError("STEP_TRANSFER_FAILED", "OCCT could not transfer the XCAF document to STEP.");
  if (writer.Write(path.c_str()) != IFSelect_RetDone)
    throw CadError("STEP_WRITE_FAILED", "OCCT could not write the STEP file.");
  return responsePrefix(requestId) + ",\"path\":\"" + JsonEscape(path)
       + "\",\"selectionType\":\"all\",\"userPropertiesIncluded\":false}";
}

std::string CadDocument::ExportBrep(const std::string& requestId, const std::string& path,
                                    const std::string& manifestPathValue,
                                    const std::string& bodyId,
                                    const std::string& selectionType,
                                    const std::string& topologyId)
{
  if (myBodies.empty()) throw CadError("DOCUMENT_EMPTY", "The document has no bodies to export.");
  const std::filesystem::path brepPath = std::filesystem::absolute(path).lexically_normal();
  const std::filesystem::path manifestPath = std::filesystem::absolute(
      manifestPathValue.empty() ? path + ".manifest.json" : manifestPathValue).lexically_normal();
  std::filesystem::create_directories(brepPath.parent_path());
  std::filesystem::create_directories(manifestPath.parent_path());

  std::vector<const BodyRecord*> bodies;
  if (!bodyId.empty()) bodies.push_back(&bodyOrActive(bodyId));
  else for (const auto& [id, body] : myBodies) bodies.push_back(&body);

  TopoDS_Shape exportShape;
  std::string resolvedBodyId;
  const std::string resolvedSelectionType = selectionType.empty() ? (bodyId.empty() ? "all" : "body") : selectionType;
  if (resolvedSelectionType == "face")
  {
    if (bodies.size() != 1) throw CadError("INVALID_MESH_SELECTION", "A face BREP export requires one Body.");
    const BodyRecord& body = *bodies.front();
    ShapeSerializer topology(body.Shape, body.TopologyRevision, body.Id);
    const int index = topology.FaceIndexFromId(topologyId);
    if (index < 1 || index > topology.Faces().Extent()) throw CadError("FACE_NOT_FOUND", "The selected Face does not exist.");
    exportShape = topology.Faces()(index);
    resolvedBodyId = body.Id;
  }
  else if (resolvedSelectionType == "body")
  {
    if (bodies.size() != 1) throw CadError("INVALID_MESH_SELECTION", "A Body BREP export requires one Body.");
    exportShape = bodies.front()->Shape;
    resolvedBodyId = bodies.front()->Id;
  }
  else if (resolvedSelectionType == "all")
  {
    BRep_Builder builder;
    TopoDS_Compound compound;
    builder.MakeCompound(compound);
    for (const BodyRecord* body : bodies) builder.Add(compound, body->Shape);
    exportShape = compound;
  }
  else throw CadError("INVALID_MESH_SELECTION", "BREP export selectionType must be all, body or face.");

  if (exportShape.IsNull() || !BRepTools::Write(exportShape, brepPath.string().c_str()))
    throw CadError("BREP_WRITE_FAILED", "OCCT could not write the BREP file.");

  std::ostringstream manifest;
  manifest << std::setprecision(12) << "{\"format\":\"brep\",\"documentId\":\"" << JsonEscape(myDocumentId)
           << "\",\"revision\":" << myRevision << ",\"selectionType\":\"" << JsonEscape(resolvedSelectionType)
           << "\",\"bodyId\":\"" << JsonEscape(resolvedBodyId) << "\",\"bodies\":[";
  std::size_t bodyIndex = 0;
  std::size_t solidIndex = 0;
  for (const BodyRecord* body : bodies)
  {
    if (bodyIndex++ > 0) manifest << ',';
    manifest << "{\"bodyId\":\"" << JsonEscape(body->Id) << "\",\"name\":\"" << JsonEscape(body->Name)
             << "\",\"kind\":\"" << JsonEscape(body->Kind) << "\",\"topologyRevision\":" << body->TopologyRevision
             << bodyIdentityJson(body->Id)
             << ",\"solids\":[";
    std::size_t bodySolidIndex = 0;
    bool firstSolid = true;
    for (TopExp_Explorer explorer(body->Shape, TopAbs_SOLID); explorer.More(); explorer.Next())
    {
      const TopoDS_Shape solid = explorer.Current();
      GProp_GProps properties;
      BRepGProp::VolumeProperties(solid, properties);
      const gp_Pnt centroid = properties.CentreOfMass();
      if (!firstSolid) manifest << ',';
      firstSolid = false;
      manifest << "{\"solidIndex\":" << solidIndex++ << ",\"bodySolidIndex\":" << bodySolidIndex++
               << ",\"volume\":" << SpatialNumber(properties.Mass()) << ",\"centroid\":" << SpatialPointJson(centroid)
               << ",\"bounds\":" << SpatialBoundsJson(solid) << "}";
    }
    manifest << "]}";
  }
  manifest << "]}";
  std::ofstream output(manifestPath, std::ios::binary | std::ios::trunc);
  if (!output) throw CadError("BREP_MANIFEST_WRITE_FAILED", "Could not create the BREP ownership manifest.");
  output << manifest.str();
  if (!output) throw CadError("BREP_MANIFEST_WRITE_FAILED", "Could not write the BREP ownership manifest.");

  return responsePrefix(requestId) + ",\"path\":\"" + JsonEscape(brepPath.string())
       + "\",\"manifestPath\":\"" + JsonEscape(manifestPath.string())
       + "\",\"selectionType\":\"" + JsonEscape(resolvedSelectionType)
       + "\",\"bodyId\":\"" + JsonEscape(resolvedBodyId) + "\",\"format\":\"brep\"}";
}}
