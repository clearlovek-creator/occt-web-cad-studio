// SPDX-License-Identifier: GPL-3.0-or-later
// Source-Face planar patches in the existing guarded tetrahedral core.
// A raw result is not ordinary mesh admission or a CAD identity certificate.
#include "DiscreteVolumeMesh.hxx"
#include "GmshSession.hxx"
#include "LocalCoordinateFrame.hxx"
#include "QualityControl.hxx"
#include "MeshCheckpoint.hxx"
#include "runtime/NativeResourceGuard.hxx"
#include <gmsh.h>
#include <cmath>
#include <iostream>
#include <map>
#include <new>
#include <set>
using J=occweb::JsonValue;
using namespace occweb::discrete;
namespace {
void require(bool b,const char* message){if(!b)throw QualityError("MESH_PATCH_INVALID",message);}
J array(){return J::MakeArray();}J object(){return J::MakeObject();}
std::size_t index(const J& v,std::size_t count){const double x=v.AsNumber();require(std::isfinite(x)&&x>=0&&std::floor(x)==x&&x<double(count),"Invalid explicit patch index.");return std::size_t(x);}
Point preparePatched(const J& request){
  require(request.IsObject(),"An explicit patched request is required.");
  for(const auto& f:request.AsObject())require(f.first=="domain"||f.first=="patchPlan"||f.first=="meshSize"||f.first=="quality"||f.first=="optimization","Unknown patched tetrahedral request field.");
  const auto& d=request.At("domain");const auto& plan=request.At("patchPlan");
  require(d.GetString("basis")=="exact-nef-membership-with-open-sheet-constraints-v1"&&plan.GetString("basis")=="exact-dyadic-source-face-planar-patches-v1"&&plan.GetInteger("version")==1,"Wrong experimental domain/patch family.");
  require(d.At("ok").AsBoolean()&&d.At("report").At("connectedCellsIndividuallyExported").AsBoolean()&&plan.At("report").At("exactPlanarCoverage").AsBoolean()&&!plan.At("report").At("normalMeshAdmitted").AsBoolean(),"Patch/source qualification flags disagree.");
  const auto& points=d.At("points").AsArray();const auto& patches=plan.At("patches").AsArray();const auto& edges=plan.At("edges").AsArray();const auto& cells=d.At("cells").AsArray();
  require(points.size()>=4&&points.size()<=60000&&patches.size()>=4&&patches.size()<=20000&&edges.size()<=60000&&cells.size()>=1&&cells.size()<=128,"Experimental topology budget exceeded.");
  const auto& origin=points.front().AsArray();require(origin.size()==3,"Invalid coordinate origin.");
  const LocalCoordinateFrame frame({origin[0].AsNumber(),origin[1].AsNumber(),origin[2].AsNumber()});
  const double size=request.GetNumber("meshSize");ConfigureVolumeMeshOptions(size);parseControls(request);
  gmsh::model::add("exact-source-face-patches-research");std::set<std::size_t> usedPoints;
  for(const auto& edge:edges)for(const auto& v:edge.At("vertices").AsArray())usedPoints.insert(index(v,points.size()));
  for(const auto i:usedPoints){const auto& row=points[i].AsArray();require(row.size()==3,"Invalid point.");const Point world={row[0].AsNumber(),row[1].AsNumber(),row[2].AsNumber()},local=frame.local(world);require(frame.world(local)==world,"Source coordinate does not round-trip.");gmsh::model::geo::addPoint(local[0],local[1],local[2],size,int(i+1));}
  for(std::size_t i=0;i<edges.size();++i){const auto& v=edges[i].At("vertices").AsArray();require(v.size()==2,"A constraint curve needs two endpoints.");gmsh::model::geo::addLine(int(index(v[0],points.size())+1),int(index(v[1],points.size())+1),int(i+1));}
  for(std::size_t i=0;i<patches.size();++i){std::vector<int> loops;
    for(const auto& loop:patches[i].At("loops").AsArray()){std::vector<int> curves;for(const auto& v:loop.At("edgeUses").AsArray()){const int tag=v.AsInteger();require(tag!=0&&std::abs(tag)<=int(edges.size()),"Invalid oriented constraint edge.");curves.push_back(tag);}require(curves.size()>=3,"Patch loop has too few curves.");loops.push_back(gmsh::model::geo::addCurveLoop(curves));}
    require(!loops.empty(),"Patch has no outer loop.");gmsh::model::geo::addPlaneSurface(loops,int(i+1));
  }
  const auto& triPatches=plan.At("trianglePatches").AsArray();require(triPatches.size()==d.At("triangles").AsArray().size(),"Missing triangle-to-patch provenance.");
  for(std::size_t c=0;c<cells.size();++c){std::vector<int> shellTags;
    for(const auto& shell:cells[c].At("shells").AsArray()){
      std::map<std::size_t,int> surfaces;
      for(const auto& v:shell.At("triangleIndexes").AsArray()){
        const auto tri=index(v,triPatches.size()),p=index(triPatches[tri],patches.size());int direction=0;
        for(const auto& use:patches[p].At("cellUses").AsArray())if(index(use.At("cellIndex"),cells.size())==c)direction=use.GetInteger("orientation");
        require(direction==1||direction==-1,"Patch lacks an explicit oriented shell owner.");surfaces[p]=direction;
      }
      std::vector<int> tags;for(const auto& entry:surfaces)tags.push_back(entry.second*int(entry.first+1));shellTags.push_back(gmsh::model::geo::addSurfaceLoop(tags));
    }
    gmsh::model::geo::addVolume(shellTags,int(c+1));
  }
  gmsh::model::geo::synchronize();
  for(std::size_t i=0;i<patches.size();++i){std::vector<int> embedded;
    for(const auto& v:patches[i].At("embeddedEdgeIndexes").AsArray())embedded.push_back(int(index(v,edges.size())+1));
    if(!embedded.empty())gmsh::model::mesh::embed(1,embedded,2,int(i+1));
    const auto& constraint=patches[i].At("constraint");if(constraint.GetString("kind")=="embedded"){
      const auto& owners=constraint.At("cellIndexes").AsArray();require(owners.size()==1,"Embedded patch lacks its containing cell.");gmsh::model::mesh::embed(2,{int(i+1)},3,int(index(owners.front(),cells.size())+1));
    }
  }
  return {origin[0].AsNumber(),origin[1].AsNumber(),origin[2].AsNumber()};
}
J exportPatched(const J& request,const Controls& controls,const J& optimization,const LocalCoordinateFrame& frame,std::vector<std::size_t>* pointNodeTags){
  const auto& d=request.At("domain");const auto& plan=request.At("patchPlan");const auto& patches=plan.At("patches").AsArray();const auto& cells=d.At("cells").AsArray();
  const auto quality=qualityJson(captureQuality(cells.size(),controls.threshold),controls);
  if(controls.strict&&!quality.At("meetsRequestedQuality").AsBoolean()){
    auto result=object();result.ChangeObject()["ok"]=J(false);result.ChangeObject()["code"]=J(std::string("MESH_QUALITY_REJECTED"));result.ChangeObject()["error"]=J(std::string("The patched mesh does not meet the requested per-cell SICN policy."));result.ChangeObject()["quality"]=quality;result.ChangeObject()["optimization"]=optimization;return result;
  }
  std::vector<std::size_t> nodeTags;std::vector<double> coordinates,param;gmsh::model::mesh::getNodes(nodeTags,coordinates,param,-1,-1,false,false);require(nodeTags.size()<=100000&&coordinates.size()==3*nodeTags.size(),"Node output budget exceeded.");
  if(pointNodeTags){std::map<std::size_t,Point> ordered;for(std::size_t i=0;i<nodeTags.size();++i)require(ordered.emplace(nodeTags[i],Point{coordinates[3*i],coordinates[3*i+1],coordinates[3*i+2]}).second,"Duplicate checkpoint node tag.");nodeTags.clear();coordinates.clear();for(const auto& item:ordered){nodeTags.push_back(item.first);coordinates.insert(coordinates.end(),item.second.begin(),item.second.end());}*pointNodeTags=nodeTags;}
  std::map<std::size_t,std::size_t> nodes;auto outputPoints=array();std::vector<Point> worldPoints;
  for(std::size_t i=0;i<nodeTags.size();++i){require(nodes.emplace(nodeTags[i],i).second,"Duplicate output node tag.");const auto p=frame.world({coordinates[3*i],coordinates[3*i+1],coordinates[3*i+2]});auto row=array();for(const auto x:p){require(std::isfinite(x)&&std::abs(x)<=1e12,"Invalid output coordinate.");row.ChangeArray().push_back(J(x));}worldPoints.push_back(p);outputPoints.ChangeArray().push_back(std::move(row));}
  auto elements=[&](int dimension,int tag,int expected,int width){std::vector<int> types;std::vector<std::vector<std::size_t>> ids,vertices;gmsh::model::mesh::getElements(types,ids,vertices,dimension,tag);auto result=array();
    for(std::size_t k=0;k<types.size();++k){require(types[k]==expected&&vertices[k].size()==std::size_t(width)*ids[k].size(),"Unexpected element family.");require(result.AsArray().size()+ids[k].size()<=200000,"Element budget exceeded.");for(std::size_t j=0;j<ids[k].size();++j){auto row=array();for(int n=0;n<width;++n)row.ChangeArray().push_back(J(double(nodes.at(vertices[k][width*j+n]))));result.ChangeArray().push_back(std::move(row));}}return result;};
  auto outputCells=array(),outputPatches=array();std::size_t total=0,surfaceCount=0,boundaryCount=0,embeddedCount=0,exteriorCount=0;double totalVolume=0;
  for(std::size_t c=0;c<cells.size();++c){auto row=object(),tets=elements(3,int(c+1),4,4),qualities=array();double volume=0;
    require(!tets.AsArray().empty()&&total+tets.AsArray().size()<=200000,"Total tetrahedron budget exceeded.");
    for(const auto& t:tets.AsArray()){
      const auto& a=worldPoints[index(t.AsArray()[0],worldPoints.size())];Point u,v,w;for(int k=0;k<3;++k){u[k]=worldPoints[index(t.AsArray()[1],worldPoints.size())][k]-a[k];v[k]=worldPoints[index(t.AsArray()[2],worldPoints.size())][k]-a[k];w[k]=worldPoints[index(t.AsArray()[3],worldPoints.size())][k]-a[k];}
      const double det=u[0]*(v[1]*w[2]-v[2]*w[1])+u[1]*(v[2]*w[0]-v[0]*w[2])+u[2]*(v[0]*w[1]-v[1]*w[0]);require(std::isfinite(det)&&det>0,"Non-positive tetrahedron volume.");volume+=det/6;
    }
    std::vector<int> types;std::vector<std::vector<std::size_t>> ids,vertices;gmsh::model::mesh::getElements(types,ids,vertices,3,int(c+1));
    for(std::size_t k=0;k<types.size();++k){std::vector<double> values;gmsh::model::mesh::getElementQualities(ids[k],values,"minSICN");require(values.size()==ids[k].size(),"Missing tetrahedron quality.");for(const auto q:values)qualities.ChangeArray().push_back(J(q));}
    const double expected=cells[c].GetNumber("volume");require(std::abs(volume-expected)<=1e-6*expected,"Patch tetrahedra do not preserve connected-cell volume.");
    total+=tets.AsArray().size();totalVolume+=volume;row.ChangeObject()["cellIndex"]=J(double(c));row.ChangeObject()["regionIndex"]=cells[c].At("regionIndex");row.ChangeObject()["sourceSolidIndexes"]=cells[c].At("sourceSolidIndexes");row.ChangeObject()["tetrahedra"]=std::move(tets);row.ChangeObject()["qualities"]=std::move(qualities);row.ChangeObject()["volume"]=J(volume);outputCells.ChangeArray().push_back(std::move(row));
  }
  for(std::size_t p=0;p<patches.size();++p){auto row=object(),triangles=elements(2,int(p+1),2,3);const auto count=triangles.AsArray().size();require(count>0&&surfaceCount+count<=200000,"Missing patch or total surface budget exceeded.");surfaceCount+=count;
    const auto kind=patches[p].At("constraint").GetString("kind");if(kind=="boundary")boundaryCount+=count;else if(kind=="embedded")embeddedCount+=count;else{require(kind=="exterior","Unknown patch classification.");exteriorCount+=count;}
    row.ChangeObject()["patchIndex"]=J(double(p));row.ChangeObject()["triangles"]=std::move(triangles);row.ChangeObject()["cellUses"]=patches[p].At("cellUses");row.ChangeObject()["sourceFaces"]=patches[p].At("sourceFaces");row.ChangeObject()["sourceTriangleIndexes"]=patches[p].At("triangleIndexes");row.ChangeObject()["sourceTriangleOrientations"]=patches[p].At("triangleOrientations");row.ChangeObject()["constraint"]=patches[p].At("constraint");outputPatches.ChangeArray().push_back(std::move(row));
  }
  auto result=object(),report=object();result.ChangeObject()["ok"]=J(true);result.ChangeObject()["basis"]=J(std::string("shared-source-face-patch-gmsh-tetra-v1"));result.ChangeObject()["gmshVersion"]=J(std::string(GMSH_API_VERSION));result.ChangeObject()["patchTopologyBasis"]=plan.At("basis");result.ChangeObject()["patchDomainSha256"]=plan.At("domainSha256");result.ChangeObject()["patchSourceInputSha256"]=plan.At("sourceInputSha256");
  result.ChangeObject()["points"]=std::move(outputPoints);result.ChangeObject()["cells"]=std::move(outputCells);result.ChangeObject()["patches"]=std::move(outputPatches);result.ChangeObject()["quality"]=quality;result.ChangeObject()["optimization"]=optimization;result.ChangeObject()["sourceSolids"]=d.At("sourceSolids");result.ChangeObject()["sources"]=d.At("sources");
  report.ChangeObject()["tetraCount"]=J(double(total));report.ChangeObject()["nodeCount"]=J(double(nodeTags.size()));report.ChangeObject()["boundaryTriangleCount"]=J(double(boundaryCount));report.ChangeObject()["surfaceTriangleCount"]=J(double(surfaceCount));report.ChangeObject()["embeddedTriangleCount"]=J(double(embeddedCount));report.ChangeObject()["exteriorTriangleCount"]=J(double(exteriorCount));report.ChangeObject()["patchCount"]=J(double(patches.size()));report.ChangeObject()["volume"]=J(totalVolume);report.ChangeObject()["minimumSICN"]=quality.At("minimumSICN");report.ChangeObject()["normalMeshAdmitted"]=J(false);report.ChangeObject()["materialPriorityAssigned"]=J(false);result.ChangeObject()["report"]=std::move(report);return result;
}
}
namespace occweb::discrete {
Point PreparePatchedVolumeDomain(const J& request){return preparePatched(request);}
J ExportPatchedVolumeMesh(const J& request,const Controls& controls,const J& optimization,const LocalCoordinateFrame& frame,std::vector<std::size_t>* pointNodeTags){return exportPatched(request,controls,optimization,frame,pointNodeTags);}
J CreatePatchedVolumeMesh(const J& request,J* checkpoint){
  const auto origin=preparePatched(request);const LocalCoordinateFrame frame(origin);const auto controls=parseControls(request);
  gmsh::model::mesh::generate(3);frame.canonicalizeMesh();const auto optimization=optimizeAndCheck(controls,request.At("domain").At("cells").AsArray().size(),request.At("patchPlan").At("patches").AsArray().size(),[&frame]{frame.canonicalizeMesh();});
  std::vector<std::size_t> tags;auto result=exportPatched(request,controls,optimization,frame,checkpoint?&tags:nullptr);
  if(checkpoint){require(result.At("ok").AsBoolean(),"A complete diagnostic mesh is required for a patched checkpoint.");*checkpoint=checkpointJson({origin,tags,captureMesh()},true);}return result;
}
}
