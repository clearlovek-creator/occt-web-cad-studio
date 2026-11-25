#pragma once

#include "../features/FeatureNode.hxx"
#include "UserPropertyStore.hxx"
#include "ParameterStore.hxx"
#include "TopologyNaming.hxx"
#include "ShapeSpatial.hxx"

#include <TDF_Label.hxx>
#include <TDocStd_Document.hxx>
#include <TopoDS_Shape.hxx>
#include <XCAFDoc_ShapeTool.hxx>

#include <iosfwd>
#include <map>
#include <string>
#include <vector>

namespace occweb
{
struct BodyRecord
{
  std::string Id;
  std::string SourceFeatureId;
  TopoDS_Shape Shape;
  TopologyNames Names;
  TDF_Label Label;
  int TopologyRevision = 0;
  std::string Name;
  bool Visible = true;
  std::string Color = "#7b91aa";
  std::string Material;
  double Opacity = 1.0;
  std::string Kind = "solid";
  mutable std::shared_ptr<const SpatialMetadata> SpatialCache;
};

std::string BodyKindFromShape(const TopoDS_Shape& shape);

// One replay/inspection engine for feature inputs and coordinate source outputs.
struct HistoricalInputTarget
{
  std::string FeatureId;
  std::string CoordinateId;
  std::string SectionId;
  std::string SweepInputId;
  bool ExplicitSource = false;
  std::string SourceFeatureId;
  std::string SourceBodyId;
  bool empty() const { return FeatureId.empty() && CoordinateId.empty(); }
};

class CadDocument
{
public:
  explicit CadDocument(std::string documentId);
  ~CadDocument() noexcept;
  CadDocument(const CadDocument&) = delete;
  CadDocument& operator=(const CadDocument&) = delete;
  std::string Reset(const std::string& requestId);

  const std::string& Id() const { return myDocumentId; }
  int Revision() const { return myRevision; }

  std::string CreateBox(const std::string& requestId, double width, double depth,
                        double height, bool reset);
  std::string CreatePrimitive(const std::string& requestId,
                              const std::string& operation,
                              const JsonValue& parameters);
  std::string Transform(const std::string& requestId, int expectedRevision,
                        const std::string& operation, const std::string& bodyId,
                        const JsonValue& parameters);
  std::string AdvancedTransform(const std::string& requestId, int expectedRevision,
                                const std::string& operation, const std::string& bodyId,
                                const JsonValue& parameters);
  std::string UpdateFeature(const std::string& requestId, int expectedRevision,
                            const std::string& featureId, const JsonValue& parameters);
  std::string PreviewFeatureInput(const std::string& requestId, int expectedRevision,
    const std::string& targetFeatureId, const std::string& editedFeatureId, const JsonValue& parameters);
  std::string PreviewFeatureInput(const std::string& requestId, int expectedRevision,
    const JsonValue& inputs, const JsonValue& parameters);
  std::string ChangeFeatureLifecycle(const std::string& requestId, int expectedRevision,
                                     const std::string& featureId, const std::string& action,
                                     const JsonValue& parameters = JsonValue::MakeObject(), const HistoricalInputTarget& inspectionTarget = {});
  std::string View(const std::string& requestId, bool includePresentations = true) const;
  std::string Preview(const std::string& requestId, int offset = 0, int limit = 0) const;
  std::string BodyPresentation(const std::string& requestId, const std::string& bodyId) const;
  std::string Fillet(const std::string& requestId, int expectedRevision,
                     const std::string& bodyId, const std::string& edgeId, double radius);
  std::string Chamfer(const std::string& requestId, int expectedRevision,
                      const std::string& bodyId, const std::string& edgeId, double distance);
  std::string OffsetFeature(const std::string& requestId, int expectedRevision,
                            const std::string& operation, const std::string& bodyId,
                            const std::string& faceId, const JsonValue& parameters);
  std::string Draft(const std::string& requestId, int expectedRevision,
                    const std::string& bodyId, const std::string& faceId,
                    const JsonValue& parameters);
  std::string Revolve(const std::string& requestId, int expectedRevision,
                    const std::string& bodyId, const std::string& faceId,
                    const JsonValue& parameters);
  std::string Sweep(const std::string& requestId, int expectedRevision,
                    const std::string& bodyId, const std::string& faceId,
                    const std::string& operation, const JsonValue& parameters,
                    const JsonValue& inputs = JsonValue::MakeObject());
  std::string Loft(const std::string& requestId, int expectedRevision,
                   const JsonValue& inputs, const JsonValue& parameters);
  std::string Pattern(const std::string& requestId, int expectedRevision,
                      const std::string& operation, const std::string& bodyId,
                      const JsonValue& parameters);
  std::string Boolean(const std::string& requestId, int expectedRevision,
                      const std::string& operation, const JsonValue& inputs,
                      const JsonValue& parameters);
  std::string DeleteBody(const std::string& requestId, int expectedRevision,
                         const std::string& bodyId);
  std::string UpdateBody(const std::string& requestId, int expectedRevision,
                         const std::string& bodyId, const JsonValue& parameters);
  std::string PreviewPropertyVector(const std::string& requestId, const JsonValue& parameters) const;
  std::string SetVariable(const std::string& requestId, int expectedRevision,
                          const JsonValue& parameters, const HistoricalInputTarget& inspectionTarget = {});
  std::string DeleteVariable(const std::string& requestId, int expectedRevision,
                             const std::string& name);
  std::string SetCoordinateSystem(const std::string& requestId, int expectedRevision,
                                  const JsonValue& parameters, const HistoricalInputTarget& inspectionTarget = {});
  std::string DeleteCoordinateSystem(const std::string& requestId, int expectedRevision,
                                     const std::string& id);
  std::string SetMaterial(const std::string& requestId, int expectedRevision,
                          const JsonValue& parameters);
  std::string SetMaterialProperty(const std::string& requestId, int expectedRevision, const JsonValue& parameters);
  std::string DeleteMaterialProperty(const std::string& requestId, int expectedRevision, const JsonValue& parameters);
  std::string DeleteMaterial(const std::string& requestId, int expectedRevision,
                             const std::string& name);
  std::string SetProperty(const std::string& requestId, int expectedRevision,
                          const std::string& kind, const std::string& bodyId,
                          const std::string& topologyId, const std::string& key,
                          const std::string& type, const JsonValue& value);
  std::string DeleteProperty(const std::string& requestId, int expectedRevision,
                             const std::string& kind, const std::string& bodyId,
                             const std::string& topologyId, const std::string& key);
  std::string ListProperties(const std::string& requestId, const std::string& kind,
                             const std::string& bodyId, const std::string& topologyId) const;
  std::string ImportStep(const std::string& requestId, const std::string& path,
                         const std::string& currentCheckpoint = {});
  // Explicit metadata migration; never invoked by opening or ordinary replay.
  std::string UpgradeImportedNaming(const std::string& requestId, int expectedRevision, bool preview);
  std::string ExportStep(const std::string& requestId, const std::string& path,
                         const std::string& bodyId = "",
                         const std::string& selectionType = "",
                         const std::string& topologyId = "");
  std::string ExportBrep(const std::string& requestId, const std::string& path,
                         const std::string& manifestPath,
                         const std::string& bodyId = "",
                         const std::string& selectionType = "",
                         const std::string& topologyId = "");
  std::string PrepareMeshSnapshot(const std::string& requestId,const std::string& path,const std::string& manifestPath,const std::string& repairMode,bool includePreview=false,bool deepCheck=false);
  std::string ExportDiscreteSurface(const std::string& requestId,const JsonValue& parameters) const;
  std::string Summary(const std::string& requestId) const;
  std::string ShapeCheck(const std::string& requestId, const std::string& bodyId) const;
  std::string Measure(const std::string& requestId, const std::string& bodyId, const std::string& selectionType, const std::string& topologyId) const;
  std::string Relation(const std::string& requestId, const std::string& firstBodyId,
                       const std::string& secondBodyId, double tolerance) const;
  std::string SaveSnapshot(const std::string& requestId, const std::string& path);
  std::string RestoreSnapshot(const std::string& requestId, const std::string& path,
                              const JsonValue& sourceBindings = JsonValue());

private:
  struct ImportedNamingUpgrade;
  std::string importStepStaged(const std::string& requestId,const std::string& path);
  void configureLoft(FeatureNode& feature,const JsonValue& sections,const JsonValue& parameters);
  void configureCurveSweep(FeatureNode& feature,const JsonValue& definition);
  std::string replayFeatureEdit(const std::string& requestId, int expectedRevision,
    const std::string& featureId, const JsonValue& parameters, const HistoricalInputTarget& inspectionTarget,
    ImportedNamingUpgrade* namingUpgrade = nullptr);
  struct EntityIdentity { std::string Body; std::string Topology; int Revision = -1; };
  std::map<std::string, EntityIdentity> myEntityIdentities;
  static std::string newIdentity();
  void synchronizeIdentities();
  std::string identitiesJson() const;
  std::string bodyIdentityJson(const std::string& id) const;
  void initializeDocument();
  void swapState(CadDocument& other) noexcept;
  void persistMetadata();
  void loadSnapshot(std::istream& input);
  void rebuildFromDocument();
  std::string nextBodyId();
  std::string nextFeatureId();
  std::string responsePrefix(const std::string& requestId) const;
  std::string featuresJson(bool includeInternal=false) const;
  std::string bodyMetadataJson() const;
  double parameterValue(const JsonValue& parameters, const std::string& key,
                        const std::string& expectedType, double fallback,
                        bool required, FeatureNode* feature = nullptr) const;
  const BodyRecord& bodyOrActive(const std::string& bodyId) const;
  BodyRecord& bodyOrActive(const std::string& bodyId);
  void validatePropertyTarget(const std::string& kind, const std::string& bodyId,
                              const std::string& topologyId) const;

private:
  std::string myDocumentId;
  int myRevision = 0;
  int myNextBody = 1;
  int myNextFeature = 1;
  std::string myActiveBodyId;
  Handle(TDocStd_Document) myDocument;
  Handle(XCAFDoc_ShapeTool) myShapeTool;
  std::map<std::string, BodyRecord> myBodies;
  std::vector<FeatureNode> myFeatures;
  UserPropertyStore myProperties;
  ScalarVariableStore myVariables;
  CoordinateSystemStore myCoordinateSystems;
  MaterialStore myMaterials;
};
}
