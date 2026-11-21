#include "DiscreteSurfaceExport.hxx"
#include "../document/CadError.hxx"
#include "../document/ShapeFingerprint.hxx"
#include <BRepBuilderAPI_Copy.hxx>
#include <BRepMesh_IncrementalMesh.hxx>
#include <BRep_Tool.hxx>
#include <Poly_Triangulation.hxx>
#include <Poly_TriangulationParameters.hxx>
#include <TopExp.hxx>
#include <TopExp_Explorer.hxx>
#include <TopTools_IndexedMapOfShape.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Face.hxx>
#include <gp_Pnt.hxx>
#include <cmath>
#include <algorithm>
#include <set>

namespace occweb
{
namespace
{
JsonValue object(){return JsonValue::MakeObject();}
JsonValue array(){return JsonValue::MakeArray();}
JsonValue number(std::size_t n){return JsonValue(double(n));}
JsonValue text(const std::string& value){return JsonValue(value);}
void need(bool value,const std::string& code,const std::string& message,const std::string& details={}){if(!value)throw CadError(code,message,details);}
bool identifier(const std::string& value){return !value.empty()&&value.size()<=80&&value.find_first_not_of("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.:-")==std::string::npos;}
bool identity(const std::string& value){return value.size()==32&&value.find_first_not_of("0123456789abcdef")==std::string::npos;}
const char* orientation(TopAbs_Orientation value){switch(value){case TopAbs_FORWARD:return "forward";case TopAbs_REVERSED:return "reversed";case TopAbs_INTERNAL:return "internal";case TopAbs_EXTERNAL:return "external";}throw CadError("SURFACE_EXPORT_SOURCE_INVALID","Unknown source orientation.");}
struct Use{int Solid=-1;TopAbs_Orientation Orientation=TopAbs_FORWARD;};
std::string solidId(const MeshPreparationBody& body,int index){return "solid-"+body.Id+'-'+std::to_string(index);}
JsonValue sourceBody(const MeshPreparationBody& body){
  auto value=object();auto& out=value.ChangeObject();out["bodyId"]=text(body.Id);out["kind"]=text(body.Kind);out["bodyIdentity"]=text(body.BodyIdentity);out["topologyIdentity"]=text(body.TopologyIdentity);out["topologyRevision"]=JsonValue(double(body.TopologyRevision));return value;
}
double option(const JsonValue& parameters,const std::string& name,double fallback,double min,double max){
  const double value=parameters.Has(name)?parameters.GetNumber(name):fallback;
  need(std::isfinite(value)&&value>=min&&value<=max,"SURFACE_EXPORT_OPTIONS_INVALID","Discrete source meshing options exceed supported bounds.");return value;
}
}

std::string DiscreteSurfaceExportCapabilityJson(){return "{\"version\":1,\"basis\":\"occt-private-copy-all-body-face-solid-v1\",\"fingerprint\":\"sha256-brep-v3-normalized-no-triangulation-v1\",\"maxBodies\":512,\"maxFaces\":10000,\"maxSolids\":4096,\"maxTriangles\":20000,\"maxInputBytes\":8388608,\"maxBundleBytes\":16777216,\"volumeDomainReconstruction\":false}";}

JsonValue ExportDiscreteSurfaceSource(const std::vector<MeshPreparationBody>& bodies,const std::string& documentId,int revision,const JsonValue& parameters)
{
  need(parameters.IsObject(),"SURFACE_EXPORT_OPTIONS_INVALID","Discrete source options must be an object.");
  for(const auto& [key,unused]:parameters.AsObject())need(key=="linearDeflection"||key=="angularDeflection"||key=="maxTriangles","SURFACE_EXPORT_OPTIONS_INVALID","Unknown discrete source option; partial Body or Face export is not supported.");
  const double linear=option(parameters,"linearDeflection",0.05,1e-6,1000),angular=option(parameters,"angularDeflection",0.15,0.01,0.5);
  const double limit=option(parameters,"maxTriangles",double(DiscreteSurfaceExportLimits::Triangles),1,double(DiscreteSurfaceExportLimits::Triangles));
  need(std::floor(limit)==limit,"SURFACE_EXPORT_OPTIONS_INVALID","Triangle budget must be an integer.");
  const auto triangleLimit=std::size_t(limit);
  need(identifier(documentId)&&revision>=0&&!bodies.empty(),"SURFACE_EXPORT_SOURCE_INVALID","A nonempty document with an explicit source revision is required.");
  need(bodies.size()<=DiscreteSurfaceExportLimits::Bodies,"SURFACE_EXPORT_TOPOLOGY_LIMIT","Source Body count exceeds the export budget.");
  auto bundle=object(),source=object(),sourceBodies=array(),inventory=object(),bodyInventory=array(),faceInventory=array(),solidInventory=array(),input=object(),points=array(),triangles=array(),sources=array();
  std::set<std::string> bodyIds,bodyIdentities;std::size_t totalFaces=0,totalSolids=0,estimateExceeds=0;double maxReportedDeflection=0;
  for(const auto& body:bodies){
    need(identifier(body.Id)&&identity(body.BodyIdentity)&&identity(body.TopologyIdentity)&&body.TopologyRevision>=0&&bodyIds.insert(body.Id).second&&bodyIdentities.insert(body.BodyIdentity).second&&!body.Shape.IsNull(),"SURFACE_EXPORT_SOURCE_INVALID","Source Body identity is incomplete or duplicated.");
    TopTools_IndexedMapOfShape originalFaces,originalSolids,originalEdges,originalVertices,faceEdges,faceVertices;
    TopExp::MapShapes(body.Shape,TopAbs_FACE,originalFaces);TopExp::MapShapes(body.Shape,TopAbs_SOLID,originalSolids);TopExp::MapShapes(body.Shape,TopAbs_EDGE,originalEdges);TopExp::MapShapes(body.Shape,TopAbs_VERTEX,originalVertices);
    need(std::size_t(originalFaces.Extent())==body.FaceIds.size(),"SURFACE_EXPORT_SOURCE_INVALID","Source Face inventory does not match original CAD topology.");
    totalFaces+=std::size_t(originalFaces.Extent());totalSolids+=std::size_t(originalSolids.Extent());
    need(totalFaces<=DiscreteSurfaceExportLimits::Faces&&totalSolids<=DiscreteSurfaceExportLimits::Solids,"SURFACE_EXPORT_TOPOLOGY_LIMIT","Source Face or Solid count exceeds the export budget.");
    for(int f=1;f<=originalFaces.Extent();f++){TopExp::MapShapes(originalFaces(f),TopAbs_EDGE,faceEdges);TopExp::MapShapes(originalFaces(f),TopAbs_VERTEX,faceVertices);need(body.FaceIds[f-1]=="face-"+std::to_string(body.TopologyRevision)+'-'+std::to_string(f),"SURFACE_EXPORT_SOURCE_INVALID","Source Face ID is not the current native topology index.");}
    need(!originalFaces.IsEmpty()&&originalEdges.Extent()==faceEdges.Extent()&&originalVertices.Extent()==faceVertices.Extent(),"SURFACE_EXPORT_UNSUPPORTED_FREE_TOPOLOGY","The complete project includes free wires or points; no geometry was silently omitted.");
    const auto fingerprint=ShapeFingerprint(body.Shape);
    std::vector<std::vector<Use>> uses(originalFaces.Extent());
    for(int s=1;s<=originalSolids.Extent();s++){
      const auto id=solidId(body,s-1);need(identifier(id),"SURFACE_EXPORT_SOURCE_INVALID","Solid identifier exceeds the source-label budget.");
      auto entry=object();entry.ChangeObject()["bodyId"]=text(body.Id);entry.ChangeObject()["solidId"]=text(id);entry.ChangeObject()["solidIndex"]=number(s-1);solidInventory.ChangeArray().push_back(std::move(entry));
      bool hasFace=false;
      for(TopExp_Explorer e(originalSolids(s),TopAbs_FACE);e.More();e.Next()){
        hasFace=true;
        const int index=originalFaces.FindIndex(e.Current());need(index>0,"SURFACE_EXPORT_SOURCE_INVALID","A source Solid references an unknown Face.");
        auto& list=uses[index-1];need(list.size()<64,"SURFACE_EXPORT_TOPOLOGY_LIMIT","Face use multiplicity exceeds the export budget.");list.push_back({s-1,e.Current().Orientation()});
      }
      need(hasFace,"SURFACE_EXPORT_EMPTY_SOLID","A source Solid contains no Faces; it was not silently omitted.");
    }
    // No triangulation is copied or reused, and no live CAD TShape is meshed.
    BRepBuilderAPI_Copy copier(body.Shape,true,false);need(copier.IsDone()&&!copier.Shape().IsNull(),"SURFACE_EXPORT_COPY_FAILED","Could not create a private CAD source copy.");
    BRepMesh_IncrementalMesh mesher(copier.Shape(),linear,false,angular,false);
    need(mesher.IsDone()&&mesher.GetStatusFlags()==0,"SURFACE_EXPORT_MESHING_FAILED","Private CAD surface tessellation did not complete cleanly.");
    for(int f=1;f<=originalFaces.Extent();f++){
      const auto& faceId=body.FaceIds[f-1];const auto mapped=copier.ModifiedShape(originalFaces(f));need(!mapped.IsNull()&&mapped.ShapeType()==TopAbs_FACE,"SURFACE_EXPORT_SOURCE_LOST","Private copy lost an original CAD Face.");
      const auto face=TopoDS::Face(mapped);TopLoc_Location location;const auto mesh=BRep_Tool::Triangulation(face,location);
      auto details=object();details.ChangeObject()["bodyId"]=text(body.Id);details.ChangeObject()["faceId"]=text(faceId);
      need(!mesh.IsNull()&&mesh->HasGeometry()&&mesh->NbTriangles()>0,"SURFACE_EXPORT_FACE_UNMESHED","A source Face has no complete surface tessellation.",JsonSerialize(details));
      // OCCT's postprocessed Deflection is an estimate, not the requested
      // parameter or a certified maximum distance. Check its recorded build
      // parameters separately and expose an over-request estimate explicitly.
      const auto parameters=mesh->Parameters();
      need(!parameters.IsNull()&&parameters->HasDeflection()&&parameters->HasAngle()&&parameters->Deflection()==linear&&parameters->Angle()==angular,"SURFACE_EXPORT_POLICY_UNVERIFIED","A source Face does not prove the requested tessellation parameters.",JsonSerialize(details));
      const double reported=mesh->Deflection();need(std::isfinite(reported)&&reported>=0,"SURFACE_EXPORT_INVALID_TRIANGULATION","The mesher reported an invalid Face deflection estimate.",JsonSerialize(details));maxReportedDeflection=std::max(maxReportedDeflection,reported);const bool exceeds=reported>linear*(1+1e-10);if(exceeds)estimateExceeds++;
      auto& faceUses=uses[f-1];if(faceUses.empty())faceUses.push_back({-1,originalFaces(f).Orientation()});
      auto entry=object(),useInventory=array(),meshingParameters=object();meshingParameters.ChangeObject()["linearDeflection"]=JsonValue(parameters->Deflection());meshingParameters.ChangeObject()["angularDeflection"]=JsonValue(parameters->Angle());auto& fields=entry.ChangeObject();fields["bodyId"]=text(body.Id);fields["faceId"]=text(faceId);fields["faceIndex"]=number(f-1);fields["triangleStart"]=number(triangles.AsArray().size());fields["mesherDeflection"]=JsonValue(reported);fields["meshingParameters"]=std::move(meshingParameters);fields["estimateExceedsRequested"]=JsonValue(exceeds);
      for(std::size_t u=0;u<faceUses.size();u++){
        const auto use=faceUses[u];auto useEntry=object();auto& data=useEntry.ChangeObject();data["useIndex"]=number(u);data["solidId"]=text(use.Solid<0?"":solidId(body,use.Solid));data["orientation"]=text(orientation(use.Orientation));data["triangleStart"]=number(triangles.AsArray().size());data["triangleCount"]=number(mesh->NbTriangles());
        need(std::size_t(mesh->NbTriangles())<=triangleLimit-triangles.AsArray().size(),"SURFACE_EXPORT_TRIANGLE_LIMIT","Complete source tessellation exceeds the triangle budget; no partial surface was returned.",JsonSerialize(details));
        for(int t=1;t<=mesh->NbTriangles();t++){
          int a,b,c;mesh->Triangle(t).Get(a,b,c);if(use.Orientation==TopAbs_REVERSED)std::swap(b,c);
          auto triangle=array();for(const int node:{a,b,c}){
            need(node>=1&&node<=mesh->NbNodes(),"SURFACE_EXPORT_INVALID_TRIANGLE","Source tessellation references an invalid node.");
            const auto point=mesh->Node(node).Transformed(location.Transformation());auto row=array();
            for(const double coordinate:{point.X(),point.Y(),point.Z()}){need(std::isfinite(coordinate)&&std::abs(coordinate)<=1e12,"SURFACE_EXPORT_COORDINATE_LIMIT","Source coordinates exceed the supported finite millimetre range.");row.ChangeArray().push_back(JsonValue(coordinate));}
            triangle.ChangeArray().push_back(number(points.AsArray().size()));points.ChangeArray().push_back(std::move(row));
          }
          auto owner=object();owner.ChangeObject()["bodyId"]=text(body.Id);owner.ChangeObject()["faceId"]=text(faceId);if(use.Solid>=0)owner.ChangeObject()["solidId"]=text(solidId(body,use.Solid));
          triangles.ChangeArray().push_back(std::move(triangle));sources.ChangeArray().push_back(std::move(owner));
        }
        useInventory.ChangeArray().push_back(std::move(useEntry));
      }
      fields["triangleCount"]=number(triangles.AsArray().size()-std::size_t(fields["triangleStart"].AsNumber()));fields["uses"]=std::move(useInventory);faceInventory.ChangeArray().push_back(std::move(entry));
    }
    need(ShapeFingerprint(body.Shape)==fingerprint,"SURFACE_EXPORT_SOURCE_CHANGED","Original CAD geometry changed during private surface export.");
    auto record=sourceBody(body);sourceBodies.ChangeArray().push_back(record);record.ChangeObject()["geometryFingerprint"]=text(fingerprint);record.ChangeObject()["faceCount"]=number(originalFaces.Extent());record.ChangeObject()["solidCount"]=number(originalSolids.Extent());bodyInventory.ChangeArray().push_back(std::move(record));
  }
  input.ChangeObject()["units"]=text("mm");input.ChangeObject()["points"]=std::move(points);input.ChangeObject()["triangles"]=std::move(triangles);input.ChangeObject()["sources"]=std::move(sources);
  need(JsonSerialize(input).size()+1024<=DiscreteSurfaceExportLimits::InputBytes,"SURFACE_EXPORT_INPUT_LIMIT","Complete source input exceeds the 8 MiB worker budget, including envelope reserve.");
  auto& src=source.ChangeObject();src["version"]=JsonValue(1.0);src["documentId"]=text(documentId);src["revision"]=JsonValue(double(revision));src["bodies"]=std::move(sourceBodies);
  inventory.ChangeObject()["bodies"]=std::move(bodyInventory);inventory.ChangeObject()["faces"]=std::move(faceInventory);inventory.ChangeObject()["solids"]=std::move(solidInventory);
  auto policy=object();auto& p=policy.ChangeObject();p["version"]=JsonValue(1.0);p["basis"]=text("occt-private-copy-absolute-deflection-v1");p["linearDeflection"]=JsonValue(linear);p["angularDeflection"]=JsonValue(angular);p["maxTriangles"]=number(triangleLimit);p["relative"]=JsonValue(false);p["sourceMeshReused"]=JsonValue(false);p["deflectionEvidence"]=text("occt-recorded-parameters-and-estimate-not-certified-distance-v1");p["distanceBoundCertified"]=JsonValue(false);
  auto report=object();auto& r=report.ChangeObject();r["complete"]=JsonValue(true);r["truncated"]=JsonValue(false);r["sourceGeometryUnchanged"]=JsonValue(true);r["bodyCount"]=number(bodies.size());r["faceCount"]=number(totalFaces);r["solidCount"]=number(totalSolids);r["triangleCount"]=number(input.At("triangles").AsArray().size());r["maxMesherDeflection"]=JsonValue(maxReportedDeflection);r["estimateExceedsRequestedFaceCount"]=number(estimateExceeds);r["tetrahedralReady"]=JsonValue(false);r["volumeDomainReconstruction"]=text("not-performed");
  auto& data=bundle.ChangeObject();data["format"]=text("web-cad-discrete-surface-source");data["version"]=JsonValue(1.0);data["basis"]=text("occt-private-copy-all-body-face-solid-v1");data["fingerprint"]=text("sha256-brep-v3-normalized-no-triangulation-v1");data["source"]=std::move(source);data["policy"]=std::move(policy);data["inventory"]=std::move(inventory);data["input"]=std::move(input);data["report"]=std::move(report);
  need(JsonSerialize(bundle).size()<=DiscreteSurfaceExportLimits::BundleBytes,"SURFACE_EXPORT_BUNDLE_LIMIT","Complete CAD source bundle exceeds 16 MiB; no partial inventory was returned.");return bundle;
}
}
