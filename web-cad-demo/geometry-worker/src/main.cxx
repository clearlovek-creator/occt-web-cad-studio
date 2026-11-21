#include "document/CadDocument.hxx"
#include "document/CadError.hxx"
#include "protocol/Json.hxx"
#include "runtime/NativeResourceGuard.hxx"
#include "mesh/DiscreteSurfaceExport.hxx"

#include <Standard_Failure.hxx>
#include <Standard_OutOfMemory.hxx>
#include <atomic>
#include <filesystem>
#ifdef _WIN32
#include <process.h>
#else
#include <unistd.h>
#endif
#include <iostream>
#include <map>
#include <memory>
#include <string>

namespace
{
using namespace occweb;

class DocumentManager
{
public:
  CadDocument& Get(const std::string& id)
  {
    auto found = myDocuments.find(id);
    if (found == myDocuments.end()) found = myDocuments.emplace(id, std::make_unique<CadDocument>(id)).first;
    return *found->second;
  }
private:
  std::map<std::string, std::unique_ptr<CadDocument>> myDocuments;
};

const JsonValue& objectOrEmpty(const JsonValue& request, const std::string& key)
{
  static const JsonValue empty = JsonValue::MakeObject();
  const JsonValue* value = request.Find(key);
  return value == nullptr ? empty : *value;
}

std::string errorJson(const std::string& requestId, const std::string& code, const std::string& message, const std::string& details = {})
{
  return "{\"ok\":false,\"protocolVersion\":1,\"requestId\":\"" + JsonEscape(requestId)
       + "\",\"code\":\"" + JsonEscape(code) + "\",\"error\":\"" + JsonEscape(message) + "\"" + (details.empty() ? "" : ",\"details\":" + details) + "}";
}

std::string dispatch(DocumentManager& manager, const JsonValue& request,const NativeResourceGuard& resourceGuard)
{
  if (!request.IsObject()) throw CadError("INVALID_REQUEST", "Request must be a JSON object.");
  if (request.GetIntegerOr("protocolVersion", 0) != 1)
    throw CadError("UNSUPPORTED_PROTOCOL", "protocolVersion must be 1.");
  const std::string requestId = request.GetStringOr("requestId", "");
  const std::string operation = request.GetString("operation");
  const std::string documentId = request.GetStringOr("documentId", "default");
  if (documentId.empty()) throw CadError("INVALID_DOCUMENT_ID", "documentId cannot be empty.");
  if (operation == "health.ping")
    return "{\"ok\":true,\"protocolVersion\":1,\"requestId\":\"" + JsonEscape(requestId)
         + "\",\"service\":\"occt-geometry-worker\",\"capabilities\":{\"version\":1,\"processResources\":"+resourceGuard.CapabilityJson()+",\"discreteSurfaceExport\":"+DiscreteSurfaceExportCapabilityJson()+",\"loftThroughHoles\":{\"version\":1,\"maxSections\":32,\"maxHolesPerSection\":16},\"faceBoundaryLoops\":{\"version\":1},\"importedTopologyNaming\":{\"version\":1,\"basis\":\"immutable-step-brep-v1\",\"sourceFingerprintAlgorithm\":\"sha256-chain-1m-v1\",\"upgrade\":{\"version\":1,\"basis\":\"unchanged-dual-replay-v1\",\"archivedRecovery\":\"exact-recertification-v1\",\"maxArchivedSources\":64,\"maxArchivedProofs\":256}}}}";

  CadDocument& document = manager.Get(documentId);
  if (operation == "document.create") return document.Reset(requestId);
  if (operation == "document.summary") return document.Summary(requestId);
  if (operation == "document.naming.preview" || operation == "document.naming.upgrade")
    return document.UpgradeImportedNaming(requestId, request.GetInteger("baseRevision"), operation == "document.naming.preview");
  const JsonValue& parameters = objectOrEmpty(request, "parameters");
  const JsonValue& inputs = objectOrEmpty(request, "inputs");
  if (operation == "primitive.box" || operation == "primitive.cylinder"
      || operation == "primitive.cone" || operation == "primitive.sphere"
      || operation == "primitive.torus" || operation == "primitive.wedge"
      || operation == "primitive.prism" || operation == "primitive.pyramid"
      || operation == "primitive.tube"
      || operation == "surface.rectangle" || operation == "surface.disk"
      || operation == "surface.cylinder" || operation == "surface.cone"
      || operation == "surface.sphere")
    return document.CreatePrimitive(requestId, operation, parameters);
  if (operation == "transform.translate" || operation == "transform.rotate"
      || operation == "transform.mirror" || operation == "transform.scale")
    return document.Transform(requestId, request.GetInteger("baseRevision"), operation,
                              inputs.GetStringOr("bodyId", ""), parameters);
  if (operation == "transform.copy" || operation == "transform.scale_non_uniform"
      || operation == "transform.coordinate" || operation == "transform.align")
    return document.AdvancedTransform(requestId, request.GetInteger("baseRevision"), operation,
                                      inputs.GetStringOr("bodyId", ""), parameters);
  if (operation == "feature.update")
    return document.UpdateFeature(requestId, request.GetInteger("baseRevision"),
                                  inputs.GetString("featureId"), parameters);
  if (operation == "feature.input.preview")
    return document.PreviewFeatureInput(requestId, request.GetInteger("baseRevision"),
      inputs, parameters);
  if (operation == "feature.suppress" || operation == "feature.restore" || operation == "feature.delete")
    return document.ChangeFeatureLifecycle(requestId, request.GetInteger("baseRevision"),
                                           inputs.GetString("featureId"), operation, parameters);
  if (operation == "document.view") return document.View(requestId, parameters.GetBooleanOr("includePresentations", true));
  if (operation == "document.preview") return document.Preview(requestId, parameters.GetIntegerOr("offset", 0), parameters.GetIntegerOr("limit", 0));
  if (operation == "body.presentation") return document.BodyPresentation(requestId, inputs.GetStringOr("bodyId", ""));
  if (operation == "geometry.check") return document.ShapeCheck(requestId, inputs.GetStringOr("bodyId", ""));
  if (operation == "geometry.measure") return document.Measure(requestId, inputs.GetStringOr("bodyId", ""), inputs.GetStringOr("selectionType", "body"), inputs.GetStringOr("selectionId", ""));
  if (operation == "geometry.relation") return document.Relation(requestId, inputs.GetString("bodyA"), inputs.GetString("bodyB"), parameters.GetNumberOr("tolerance", 1.0e-6));
  if (operation == "detail.fillet")
    return document.Fillet(requestId, request.GetInteger("baseRevision"), inputs.GetStringOr("bodyId", ""),
                           inputs.GetString("edgeId"), parameters.GetNumber("radius"));
  if (operation == "detail.chamfer")
    return document.Chamfer(requestId, request.GetInteger("baseRevision"), inputs.GetStringOr("bodyId", ""),
                            inputs.GetString("edgeId"), parameters.GetNumber("distance"));
  if (operation == "detail.shell" || operation == "detail.thicken" || operation == "detail.offset")
    return document.OffsetFeature(requestId, request.GetInteger("baseRevision"), operation,
                                  inputs.GetStringOr("bodyId", ""),
                                  inputs.GetStringOr("faceId", ""), parameters);
  if (operation == "detail.revolve")
    return document.Revolve(requestId, request.GetInteger("baseRevision"), inputs.GetStringOr("bodyId", ""), inputs.GetString("faceId"), parameters);
  if (operation == "detail.sweep" || operation == "detail.pipe")
    return document.Sweep(requestId, request.GetInteger("baseRevision"), inputs.GetStringOr("bodyId", ""), inputs.GetStringOr("faceId", ""), operation, parameters,inputs);
  if (operation == "detail.loft")
    return document.Loft(requestId, request.GetInteger("baseRevision"), inputs, parameters);
  if (operation == "detail.draft")
    return document.Draft(requestId, request.GetInteger("baseRevision"),
                          inputs.GetStringOr("bodyId", ""), inputs.GetString("faceId"), parameters);
  if (operation == "pattern.linear" || operation == "pattern.circular" || operation == "pattern.rectangular" || operation == "pattern.mirror")
    return document.Pattern(requestId, request.GetInteger("baseRevision"), operation,
                             inputs.GetStringOr("bodyId", ""), parameters);
  if (operation == "boolean.fuse" || operation == "boolean.cut" || operation == "boolean.common"
      || operation == "boolean.section" || operation == "boolean.split"
      || operation == "boolean.partition" || operation == "boolean.fragments"
      || operation == "boolean.imprint")
    return document.Boolean(requestId, request.GetInteger("baseRevision"), operation, inputs, parameters);
  if (operation == "body.delete")
    return document.DeleteBody(requestId, request.GetInteger("baseRevision"),
                               inputs.GetString("bodyId"));
  if (operation == "body.update")
    return document.UpdateBody(requestId, request.GetInteger("baseRevision"),
                               inputs.GetString("bodyId"), parameters);
  if (operation == "variable.set")
    return document.SetVariable(requestId, request.GetInteger("baseRevision"), parameters);
  if (operation == "variable.delete")
    return document.DeleteVariable(requestId, request.GetInteger("baseRevision"),
                                   inputs.GetString("name"));
  if (operation == "coordinate.set")
    return document.SetCoordinateSystem(requestId, request.GetInteger("baseRevision"), parameters);
  if (operation == "coordinate.delete")
    return document.DeleteCoordinateSystem(requestId, request.GetInteger("baseRevision"),
                                           inputs.GetString("id"));
  if (operation == "material.set")
    return document.SetMaterial(requestId, request.GetInteger("baseRevision"), parameters);
  if (operation == "material.property.set") return document.SetMaterialProperty(requestId, request.GetInteger("baseRevision"), parameters);
  if (operation == "material.property.delete") return document.DeleteMaterialProperty(requestId, request.GetInteger("baseRevision"), parameters);
  if (operation == "material.delete")
    return document.DeleteMaterial(requestId, request.GetInteger("baseRevision"),
                                   inputs.GetString("name"));
  if (operation == "property.set")
    return document.SetProperty(requestId, request.GetInteger("baseRevision"),
                                inputs.GetString("kind"), inputs.GetString("bodyId"),
                                inputs.GetStringOr("topologyId", ""), parameters.GetString("key"),
                                parameters.GetString("type"), parameters.At("value"));
  if (operation == "property.delete")
    return document.DeleteProperty(requestId, request.GetInteger("baseRevision"),
                                   inputs.GetString("kind"), inputs.GetString("bodyId"),
                                   inputs.GetStringOr("topologyId", ""), parameters.GetString("key"));
  if (operation == "property.list")
    return document.ListProperties(requestId, inputs.GetStringOr("kind", ""),
                                   inputs.GetStringOr("bodyId", ""), inputs.GetStringOr("topologyId", ""));
  if (operation == "step.import") return document.ImportStep(requestId, parameters.GetString("path"));
  if (operation == "step.export") return document.ExportStep(requestId, parameters.GetString("path"),
                                     parameters.GetStringOr("bodyId", ""),
                                     parameters.GetStringOr("selectionType", ""),
                                     parameters.GetStringOr("topologyId", ""));
  if (operation == "mesh.prepare") return document.PrepareMeshSnapshot(requestId,parameters.GetString("path"),parameters.GetString("manifestPath"),parameters.GetStringOr("repairMode","conservative"),parameters.GetBooleanOr("includePreview",false),parameters.GetBooleanOr("deepCheck",false));
  if (operation == "mesh.discrete.export") return document.ExportDiscreteSurface(requestId,parameters);
  if (operation == "brep.export") return document.ExportBrep(requestId, parameters.GetString("path"),
                                     parameters.GetStringOr("manifestPath", ""),
                                     parameters.GetStringOr("bodyId", ""),
                                     parameters.GetStringOr("selectionType", ""),
                                     parameters.GetStringOr("topologyId", ""));  if (operation == "document.snapshot") return document.SaveSnapshot(requestId, parameters.GetString("path"));
  if (operation == "document.restore") return document.RestoreSnapshot(requestId, parameters.GetString("path"), parameters.Find("sourceBindings") ? parameters.At("sourceBindings") : JsonValue());
  throw CadError("UNKNOWN_OPERATION", "Unknown geometry operation: " + operation);
}
}

bool isMutationOperation(const std::string& operation) {
  if (operation == "feature.input.preview") return false;
  if (operation == "property.list") return false;
  return operation == "document.create" || operation == "step.import" || operation == "document.naming.upgrade"
      || operation.rfind("primitive.", 0) == 0
      || operation.rfind("surface.", 0) == 0
      || operation.rfind("transform.", 0) == 0
      || operation.rfind("feature.", 0) == 0
      || operation.rfind("detail.", 0) == 0
      || operation.rfind("pattern.", 0) == 0
      || operation.rfind("boolean.", 0) == 0
      || operation.rfind("body.", 0) == 0
      || operation.rfind("variable.", 0) == 0
      || operation.rfind("coordinate.", 0) == 0
      || operation.rfind("material.", 0) == 0
      || operation.rfind("property.", 0) == 0;
}

std::string addTransactionMetadata(std::string result, const int beforeRevision, const int afterRevision)
{
  if (result.empty() || result.back() != '}') return result;
  result.pop_back();
  result += ",\"transaction\":{\"state\":\"committed\",\"beforeRevision\":"
          + std::to_string(beforeRevision) + ",\"afterRevision\":"
          + std::to_string(afterRevision) + "}}";
  return result;
}

std::string dispatchTransactional(DocumentManager& manager, const JsonValue& request,const NativeResourceGuard& resourceGuard)
{
  if (!request.IsObject()) return dispatch(manager, request,resourceGuard);
  const std::string operation = request.GetStringOr("operation", "");
  if (!isMutationOperation(operation)) return dispatch(manager, request,resourceGuard);

  const std::string documentId = request.GetStringOr("documentId", "default");
  CadDocument& document = manager.Get(documentId);
  static std::atomic<unsigned long long> sequence = 0;
  const auto id = ++sequence;
#ifdef _WIN32
  const auto processId = _getpid();
#else
  const auto processId = getpid();
#endif
  const std::filesystem::path checkpoint = std::filesystem::temp_directory_path()
      / ("occt-web-cad-transaction-" + std::to_string(processId) + "-" + std::to_string(id) + ".xbf");
  const std::string checkpointPath = checkpoint.string();
  const int beforeRevision = document.Revision();
  bool checkpointSaved = false;
  try
  {
    document.SaveSnapshot("transaction-checkpoint", checkpointPath);
    checkpointSaved = true;
    const std::string result = dispatch(manager, request,resourceGuard);
    const int afterRevision = document.Revision();
    std::error_code ignored;
    std::filesystem::remove(checkpoint, ignored);
    return addTransactionMetadata(result, beforeRevision, afterRevision);
  }
  catch (const Standard_OutOfMemory&) { NativeResourceGuard::AllocationFailure(); }
  catch (const std::bad_alloc&) { NativeResourceGuard::AllocationFailure(); }
  catch (...)
  {
    if (checkpointSaved)
    {
      try
      {
        document.RestoreSnapshot("transaction-rollback", checkpointPath);
      }
      catch (const std::exception& rollbackError)
      {
        std::error_code ignored;
        std::filesystem::remove(checkpoint, ignored);
        throw CadError("TRANSACTION_ROLLBACK_FAILED", std::string("Rollback failed: ") + rollbackError.what());
      }
    }
    std::error_code ignored;
    std::filesystem::remove(checkpoint, ignored);
    throw;
  }
}
int runWorker()
{
  NativeResourceGuard resourceGuard;
  std::ios::sync_with_stdio(false);
  std::cin.tie(nullptr);
  DocumentManager manager;
  std::string line;
  while (std::getline(std::cin, line))
  {
    if (line.empty()) continue;
    std::string requestId;
    try
    {
      const JsonValue request = JsonParser(line).Parse();
      if (request.IsObject()) requestId = request.GetStringOr("requestId", "");
      std::cout << dispatchTransactional(manager, request,resourceGuard) << '\n';
    }
    catch (const Standard_OutOfMemory&) { NativeResourceGuard::AllocationFailure(); }
    catch (const std::bad_alloc&) { NativeResourceGuard::AllocationFailure(); }
    catch (const CadError& error) { std::cout << errorJson(requestId, error.Code(), error.what(), error.Details()) << '\n'; }
    catch (const JsonError& error) { std::cout << errorJson(requestId, "INVALID_JSON", error.what()) << '\n'; }
    catch (const Standard_Failure& error) { std::cout << errorJson(requestId, "OCCT_FAILURE", error.what()) << '\n'; }
    catch (const std::exception& error) { std::cout << errorJson(requestId, "INTERNAL_ERROR", error.what()) << '\n'; }
    std::cout.flush();
  }
  return 0;
}
int main(){
  try{return runWorker();}
  catch(const occweb::NativeResourceGuardError& error){std::cerr<<"Native resource guard unavailable: "<<error.what()<<'\n';return error.ExitCode();}
  catch(const std::bad_alloc&){occweb::NativeResourceGuard::AllocationFailure();}
  catch(const std::exception& error){std::cerr<<"Native startup failed: "<<error.what()<<'\n';return occweb::NativeResourceGuard::UnavailableExitCode;}
}
