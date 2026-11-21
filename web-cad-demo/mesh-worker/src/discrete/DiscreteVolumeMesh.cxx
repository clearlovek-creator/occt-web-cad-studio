// SPDX-License-Identifier: GPL-3.0-or-later
// Shared discrete-boundary tetrahedral core. No arbitrary file IO.
#include "protocol/Json.hxx"
#include "runtime/NativeResourceGuard.hxx"
#include "QualityControl.hxx"
#include "LocalCoordinateFrame.hxx"
#include "DiscreteVolumeMesh.hxx"
#include "MeshCheckpoint.hxx"
#include <gmsh.h>
#include <algorithm>
#include <array>
#include <cmath>
#include <iostream>
#include <new>
#include <map>
#include <set>
#include <stdexcept>
#include <string>
#include <vector>
namespace {
using J=occweb::JsonValue;using Point=std::array<double,3>;using Tri=std::array<std::size_t,3>;
void require(bool b,const char* code,const char* message){if(!b)throw occweb::discrete::QualityError(code,message);}
J array(){return J::MakeArray();}J object(){return J::MakeObject();}J num(double n){return J(n);}J str(const std::string& s){return J(s);}
std::size_t index(const J& v,std::size_t n){const double x=v.AsNumber();require(std::isfinite(x)&&x>=0&&std::floor(x)==x&&x<double(n),"MESH_INPUT_INVALID","Index is outside its explicit source inventory.");return std::size_t(x);}
double determinant(const Point& a,const Point& b,const Point& c,const Point& d){Point u,v,w;for(int i=0;i<3;++i){u[i]=b[i]-a[i];v[i]=c[i]-a[i];w[i]=d[i]-a[i];}return u[0]*(v[1]*w[2]-v[2]*w[1])+u[1]*(v[2]*w[0]-v[0]*w[2])+u[2]*(v[0]*w[1]-v[1]*w[0]);}
}
namespace occweb::discrete {
void ConfigureVolumeMeshOptions(double size){
 require(std::isfinite(size)&&size>=1e-6&&size<=1e6,"MESH_SIZE_INVALID","A finite positive mesh size is required.");
 gmsh::option::setNumber("General.Terminal",0);gmsh::option::setNumber("General.NumThreads",1);gmsh::option::setNumber("Mesh.Algorithm3D",1);gmsh::option::setNumber("Mesh.MeshOnlyEmpty",0);gmsh::option::setNumber("Mesh.MeshSizeMin",size);gmsh::option::setNumber("Mesh.MeshSizeMax",size);gmsh::option::setNumber("Mesh.Optimize",0);gmsh::option::setNumber("Mesh.OptimizeNetgen",0);gmsh::option::setNumber("Mesh.MeshSizeFromPoints",0);gmsh::option::setNumber("Mesh.MeshSizeExtendFromBoundary",0);gmsh::model::mesh::setSizeCallback([size](int,int,double,double,double,double){return size;});
}
static Point PrepareVolumeDomain(const J& request,bool constrained=false){
 require(gmsh::isInitialized()!=0,"MESH_INITIALIZATION_REQUIRED","The caller must own an initialized Gmsh session.");
 require(request.IsObject(),"MESH_INPUT_INVALID","One object request is required.");for(const auto& field:request.AsObject())require(field.first=="domain"||field.first=="meshSize"||field.first=="optimization"||field.first=="quality","MESH_INPUT_INVALID","Paths and unknown request fields are not accepted.");const auto controls=parseControls(request);const auto& d=request.At("domain");require(d.At("ok").AsBoolean()&&d.GetString("basis")== (constrained?"exact-nef-membership-with-open-sheet-constraints-v1":"exact-nef-membership-partition-shared-refined-boundary-v1")&&d.At("report").At("connectedCellsIndividuallyExported").AsBoolean(),"MESH_DOMAIN_UNQUALIFIED","An explicit, individually exported domain of the requested family is required.");
 const auto& inputPoints=d.At("points").AsArray();const auto& triangles=d.At("triangles").AsArray();const auto& cells=d.At("cells").AsArray();const auto& uses=d.At("triangleCellUses").AsArray();require(inputPoints.size()>=4&&inputPoints.size()<=60000&&triangles.size()>=4&&triangles.size()<=20000&&cells.size()>=1&&cells.size()<=128&&uses.size()==triangles.size(),"MESH_INPUT_LIMIT","Discrete points, triangles or connected cells exceed the research budget.");const double size=request.GetNumberOr("meshSize",1);require(std::isfinite(size)&&size>=1e-6&&size<=1e6,"MESH_SIZE_INVALID","A finite positive research mesh size is required.");
 std::vector<Point> points;std::vector<double> coordinates;for(const auto& row:inputPoints){require(row.AsArray().size()==3,"MESH_INPUT_INVALID","A point needs three coordinates.");Point point;for(int i=0;i<3;++i){point[i]=row.AsArray()[i].AsNumber();require(std::isfinite(point[i])&&std::abs(point[i])<=1e12,"MESH_INPUT_INVALID","Finite bounded coordinates required.");}points.push_back(point);}
 const LocalCoordinateFrame frame(points.front());
 for(const auto& point:points){const auto local=frame.local(point);require(frame.world(local)==point,"MESH_COORDINATE_PRECISION","Source coordinates cannot round-trip through the internal local frame.");coordinates.insert(coordinates.end(),local.begin(),local.end());}
 std::vector<std::vector<int>> embedded(cells.size());
 if(constrained){const auto& constraints=d.At("constraints");require(constraints.GetInteger("version")==1&&constraints.GetString("basis")=="exact-triangle-closed-cell-membership-v1"&&constraints.At("triangles").AsArray().size()==triangles.size(),"MESH_CONSTRAINT_INVALID","Exact source-triangle constraint membership is required.");}
 std::vector<Tri> tris;std::vector<std::map<std::size_t,int>> cellTriangles(cells.size());for(std::size_t i=0;i<triangles.size();++i){const auto& row=triangles[i].AsArray();require(row.size()==3,"MESH_INPUT_INVALID","A boundary face needs three points.");Tri tri={index(row[0],points.size()),index(row[1],points.size()),index(row[2],points.size())};require(tri[0]!=tri[1]&&tri[1]!=tri[2]&&tri[0]!=tri[2],"MESH_INPUT_INVALID","Repeated boundary point.");tris.push_back(tri);const auto& owners=uses[i].AsArray();
   if(constrained){const auto& constraint=d.At("constraints").At("triangles").AsArray()[i];const auto kind=constraint.GetString("kind");const auto& containing=constraint.At("cellIndexes").AsArray();
     require(constraint.AsObject().size()==2,"MESH_CONSTRAINT_INVALID","Unknown constraint field.");
     if(kind=="embedded"){require(owners.empty()&&containing.size()==1,"MESH_CONSTRAINT_INVALID","An embedded triangle has one containing cell and no shell use.");embedded[index(containing.front(),cells.size())].push_back(int(i+1));continue;}
     if(kind=="exterior"){require(owners.empty()&&containing.empty(),"MESH_CONSTRAINT_INVALID","An exterior triangle has no volume owner.");continue;}
     require(kind=="boundary"&&containing.empty(),"MESH_CONSTRAINT_INVALID","A boundary constraint retains its explicit shell uses.");
   }
   require(owners.size()==1||owners.size()==2,"MESH_INTERFACE_INVALID","A boundary has one or two cell uses.");int orientation=0;std::set<std::size_t> seen;for(const auto& use:owners){const auto c=index(use.At("cellIndex"),cells.size());const int sign=use.At("orientation").AsInteger();require((sign==1||sign==-1)&&seen.insert(c).second,"MESH_INTERFACE_INVALID","Repeated or unoriented cell use.");orientation+=sign;cellTriangles[c][i]=sign;}require(owners.size()!=2||orientation==0,"MESH_INTERFACE_INVALID","A common interface must have opposite uses.");}
 std::vector<std::vector<std::vector<int>>> shells(cells.size());for(std::size_t c=0;c<cells.size();++c){require(cells[c].At("closed").AsBoolean()&&cells[c].GetNumber("volume")>0,"MESH_CELL_INVALID","A positive closed cell is required.");std::set<std::size_t> consumed;const auto& rows=cells[c].At("shells").AsArray();require(!rows.empty()&&rows.size()<=128,"MESH_CELL_INVALID","Explicit outer and cavity shells are required.");for(std::size_t s=0;s<rows.size();++s){require(rows[s].At("outer").AsBoolean()==(s==0),"MESH_CELL_INVALID","Exactly the first shell must be the outer shell.");std::vector<int> tags;for(const auto& item:rows[s].At("triangleIndexes").AsArray()){const auto i=index(item,triangles.size());require(cellTriangles[c].count(i)&&consumed.insert(i).second,"MESH_CELL_INVALID","Shell triangles disagree with exact cell uses.");tags.push_back(cellTriangles[c][i]*int(i+1));}require(tags.size()>=4,"MESH_CELL_INVALID","A shell has insufficient faces.");shells[c].push_back(std::move(tags));}require(consumed.size()==cellTriangles[c].size(),"MESH_CELL_INVALID","A cell boundary triangle is absent from its shells.");}
 ConfigureVolumeMeshOptions(size);gmsh::model::add("exact-shared-domain");
 if(constrained){
   // Automatic topology inference can merge two outer triangle edges into a
   // bent discrete curve. Remeshing that curve can cut off a Sheet corner.
   // Keep EVERY refined vertex and shared edge explicit; each source triangle
   // is an exact planar facet, not an approximation of a CAD surface.
   for(std::size_t i=0;i<points.size();++i)gmsh::model::geo::addPoint(coordinates[3*i],coordinates[3*i+1],coordinates[3*i+2],size,int(i+1));
   std::map<std::array<std::size_t,2>,int> edges;
   for(std::size_t i=0;i<tris.size();++i){std::vector<int> boundary;for(int side=0;side<3;++side){const auto a=tris[i][side],b=tris[i][(side+1)%3];const std::array<std::size_t,2> key={std::min(a,b),std::max(a,b)};auto found=edges.find(key);if(found==edges.end()){const int tag=int(edges.size()+1);gmsh::model::geo::addLine(int(key[0]+1),int(key[1]+1),tag);found=edges.emplace(key,tag).first;}boundary.push_back((a<b?1:-1)*found->second);}const int loop=gmsh::model::geo::addCurveLoop(boundary);gmsh::model::geo::addPlaneSurface({loop},int(i+1));}
 }else{
   for(std::size_t i=0;i<tris.size();++i)gmsh::model::addDiscreteEntity(2,int(i+1));std::vector<std::size_t> nodeTags;for(std::size_t i=0;i<points.size();++i)nodeTags.push_back(i+1);gmsh::model::mesh::addNodes(2,1,nodeTags,coordinates);for(std::size_t i=0;i<tris.size();++i)gmsh::model::mesh::addElementsByType(int(i+1),2,{i+1},{tris[i][0]+1,tris[i][1]+1,tris[i][2]+1});
   gmsh::model::mesh::createTopology(false,true);gmsh::model::mesh::createGeometry();
 }
 for(std::size_t c=0;c<cells.size();++c){std::vector<int> loops;for(const auto& shell:shells[c])loops.push_back(gmsh::model::geo::addSurfaceLoop(shell));gmsh::model::geo::addVolume(loops,int(c+1));}gmsh::model::geo::synchronize();
 for(std::size_t c=0;c<embedded.size();++c)if(!embedded[c].empty())gmsh::model::mesh::embed(2,embedded[c],3,int(c+1));
 return points.front();
}
static J CreateVolumeMeshImpl(const J& request,J* checkpoint,bool constrained){
 const auto origin=PrepareVolumeDomain(request,constrained);const LocalCoordinateFrame frame(origin);const auto controls=parseControls(request);const auto& d=request.At("domain");const auto& cells=d.At("cells").AsArray();const auto& tris=d.At("triangles").AsArray();gmsh::model::mesh::generate(3);
 frame.canonicalizeMesh();
 const auto optimization=optimizeAndCheck(controls,cells.size(),tris.size(),[&frame]{frame.canonicalizeMesh();});std::vector<std::size_t> pointTags;auto result=ExportVolumeMesh(d,controls,optimization,frame,checkpoint?&pointTags:nullptr);
 if(checkpoint){require(result.At("ok").AsBoolean(),"MESH_CHECKPOINT_INVALID","A complete unoptimized mesh is required for a checkpoint.");*checkpoint=checkpointJson({origin,pointTags,captureMesh()});}
 return result;
}
J CreateVolumeMesh(const J& request,J* checkpoint){return CreateVolumeMeshImpl(request,checkpoint,false);}
J CreateConstrainedVolumeMesh(const J& request){return CreateVolumeMeshImpl(request,nullptr,true);}
J ExportVolumeMesh(const J& d,const Controls& controls,const J& optimization,const LocalCoordinateFrame& frame,std::vector<std::size_t>* pointNodeTags){
 const auto& cells=d.At("cells").AsArray();const auto& tris=d.At("triangles").AsArray();const auto& uses=d.At("triangleCellUses").AsArray();const auto quality=qualityJson(captureQuality(cells.size(),controls.threshold),controls);
 std::vector<std::size_t> tags;std::vector<double> xyz,param;gmsh::model::mesh::getNodes(tags,xyz,param,-1,-1,false,false);require(tags.size()<=100000&&xyz.size()==3*tags.size(),"MESH_OUTPUT_LIMIT","Node output exceeds the research budget.");
 if(pointNodeTags){std::map<std::size_t,Point> ordered;for(std::size_t i=0;i<tags.size();++i)require(ordered.emplace(tags[i],Point{xyz[3*i],xyz[3*i+1],xyz[3*i+2]}).second,"MESH_NODE_INVALID","Duplicate checkpoint node tag.");tags.clear();xyz.clear();for(const auto& item:ordered){tags.push_back(item.first);xyz.insert(xyz.end(),item.second.begin(),item.second.end());}*pointNodeTags=tags;}
 std::map<std::size_t,std::size_t> nodes;std::vector<Point> outPoints;auto outCoordinates=array();for(std::size_t i=0;i<tags.size();++i){require(nodes.emplace(tags[i],i).second,"MESH_NODE_INVALID","Duplicate Gmsh node tag.");Point p=frame.world({xyz[3*i],xyz[3*i+1],xyz[3*i+2]});require(std::all_of(p.begin(),p.end(),[](double x){return std::isfinite(x);}),"MESH_NODE_INVALID","Non-finite output point.");outPoints.push_back(p);auto row=array();row.ChangeArray()={num(p[0]),num(p[1]),num(p[2])};outCoordinates.ChangeArray().push_back(std::move(row));}
 auto outCells=array();std::size_t total=0;double totalVolume=0,minQuality=1;for(std::size_t c=0;c<cells.size();++c){std::vector<int> types;std::vector<std::vector<std::size_t>> ids,vertices;gmsh::model::mesh::getElements(types,ids,vertices,3,int(c+1));auto row=object(),tets=array(),qualityRows=array();double volume=0;std::size_t cellCount=0;for(std::size_t k=0;k<types.size();++k){require(types[k]==4&&vertices[k].size()==4*ids[k].size(),"MESH_ELEMENT_UNSUPPORTED","Only first-order tetrahedra are accepted by this experiment.");require(total+ids[k].size()<=200000,"MESH_OUTPUT_LIMIT","Tetrahedron output exceeds 200000 cells.");std::vector<double> qualities;gmsh::model::mesh::getElementQualities(ids[k],qualities,"minSICN");require(qualities.size()==ids[k].size(),"MESH_QUALITY_INVALID","Missing numeric tetrahedron quality.");for(std::size_t i=0;i<ids[k].size();++i){std::array<std::size_t,4> n;auto tet=array();for(int j=0;j<4;++j){n[j]=nodes.at(vertices[k][4*i+j]);tet.ChangeArray().push_back(num(double(n[j])));}const double det=determinant(outPoints[n[0]],outPoints[n[1]],outPoints[n[2]],outPoints[n[3]]);require(std::isfinite(det)&&det>0&&std::isfinite(qualities[i])&&qualities[i]>0&&qualities[i]<=1.00001,"MESH_TET_INVALID","Degenerate, inverted or non-finite tetrahedron rejected.");volume+=det/6;minQuality=std::min(minQuality,qualities[i]);tets.ChangeArray().push_back(std::move(tet));qualityRows.ChangeArray().push_back(num(qualities[i]));cellCount++;}total+=ids[k].size();}const double expected=cells[c].GetNumber("volume");require(cellCount>0&&std::abs(volume-expected)<=1e-6*expected,"MESH_VOLUME_COVERAGE","Generated tetrahedra do not cover the original connected-cell volume.");row.ChangeObject()["cellIndex"]=num(double(c));row.ChangeObject()["regionIndex"]=cells[c].At("regionIndex");row.ChangeObject()["sourceSolidIndexes"]=cells[c].At("sourceSolidIndexes");row.ChangeObject()["tetrahedra"]=std::move(tets);row.ChangeObject()["qualities"]=std::move(qualityRows);row.ChangeObject()["volume"]=num(volume);outCells.ChangeArray().push_back(std::move(row));totalVolume+=volume;}
 auto boundaries=array();std::size_t boundaryCount=0;for(std::size_t i=0;i<tris.size();++i){std::vector<int> types;std::vector<std::vector<std::size_t>> ids,vertices;gmsh::model::mesh::getElements(types,ids,vertices,2,int(i+1));auto triangles=array(),row=object();for(std::size_t k=0;k<types.size();++k){require(types[k]==2&&vertices[k].size()==3*ids[k].size(),"MESH_BOUNDARY_INVALID","Only triangular boundary facets are supported.");boundaryCount+=ids[k].size();require(boundaryCount<=200000,"MESH_OUTPUT_LIMIT","Boundary output exceeds 200000 triangles.");for(std::size_t j=0;j<ids[k].size();++j){auto face=array();for(int n=0;n<3;++n)face.ChangeArray().push_back(num(double(nodes.at(vertices[k][3*j+n]))));triangles.ChangeArray().push_back(std::move(face));}}require(!triangles.AsArray().empty(),"MESH_BOUNDARY_MISSING","A source boundary surface disappeared.");row.ChangeObject()["sourceBoundaryTriangle"]=num(double(i));row.ChangeObject()["triangles"]=std::move(triangles);row.ChangeObject()["cellUses"]=uses[i];row.ChangeObject()["sourceTriangleIds"]=d.At("sourceTriangleIds").AsArray()[i];boundaries.ChangeArray().push_back(std::move(row));}
 const bool constrained=d.GetString("basis")=="exact-nef-membership-with-open-sheet-constraints-v1";
 std::size_t shellCount=constrained?0:boundaryCount,embeddedCount=0,exteriorCount=0;
 if(constrained)for(std::size_t i=0;i<boundaries.AsArray().size();++i){auto& row=boundaries.ChangeArray()[i];const auto& constraint=d.At("constraints").At("triangles").AsArray()[i];row.ChangeObject()["constraint"]=constraint;const auto count=row.At("triangles").AsArray().size();if(constraint.GetString("kind")=="boundary")shellCount+=count;else if(constraint.GetString("kind")=="embedded")embeddedCount+=count;else exteriorCount+=count;}
 auto result=object(),report=object();result.ChangeObject()["ok"]=J(true);result.ChangeObject()["basis"]=str(constrained?"shared-constrained-discrete-cells-gmsh-tetra-v1":"shared-discrete-connected-cells-gmsh-tetra-v1");result.ChangeObject()["gmshVersion"]=str(GMSH_API_VERSION);result.ChangeObject()["points"]=std::move(outCoordinates);result.ChangeObject()["cells"]=std::move(outCells);result.ChangeObject()["boundaries"]=std::move(boundaries);result.ChangeObject()["sourceSolids"]=d.At("sourceSolids");result.ChangeObject()["sources"]=d.At("sources");report.ChangeObject()["tetraCount"]=num(double(total));report.ChangeObject()["nodeCount"]=num(double(tags.size()));report.ChangeObject()["boundaryTriangleCount"]=num(double(shellCount));report.ChangeObject()["volume"]=num(totalVolume);report.ChangeObject()["minimumSICN"]=num(minQuality);report.ChangeObject()["normalMeshAdmitted"]=J(false);report.ChangeObject()["materialPriorityAssigned"]=J(false);
 if(constrained){report.ChangeObject()["surfaceTriangleCount"]=num(double(boundaryCount));report.ChangeObject()["embeddedTriangleCount"]=num(double(embeddedCount));report.ChangeObject()["exteriorTriangleCount"]=num(double(exteriorCount));}
 result.ChangeObject()["report"]=std::move(report);result.ChangeObject()["quality"]=quality;result.ChangeObject()["optimization"]=optimization;
 if(controls.strict&&!quality.At("meetsRequestedQuality").AsBoolean()){auto rejected=object();rejected.ChangeObject()["ok"]=J(false);rejected.ChangeObject()["code"]=str("MESH_QUALITY_REJECTED");rejected.ChangeObject()["error"]=str("The mesh does not meet the requested per-cell SICN policy.");rejected.ChangeObject()["quality"]=quality;rejected.ChangeObject()["optimization"]=optimization;return rejected;}return result;
}
}
