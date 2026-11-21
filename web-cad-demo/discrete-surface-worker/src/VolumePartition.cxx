// SPDX-License-Identifier: GPL-3.0-or-later
// Exact Nef set partition over the existing shared surface arrangement.
// Caller-supplied labels remain labels, not CAD identity certificates.
#include "VolumePartition.hxx"
#include "SurfaceRefinement.hxx"
#include <CGAL/Exact_predicates_exact_constructions_kernel.h>
#include <CGAL/Nef_polyhedron_3.h>
#include <CGAL/Surface_mesh.h>
#include <CGAL/boost/graph/convert_nef_polyhedron_to_polygon_mesh.h>
#include <CGAL/Polygon_mesh_processing/measure.h>
#include <CGAL/Polygon_mesh_processing/orientation.h>
#include <CGAL/boost/graph/helpers.h>
#include <CGAL/version.h>
#include <array>
#include <algorithm>
#include <cmath>
#include <map>
#include <set>
#include <queue>
#include <string>
#include <vector>
namespace{
using J=occweb::JsonValue;using K=CGAL::Exact_predicates_exact_constructions_kernel;using Point=K::Point_3;using Mesh=CGAL::Surface_mesh<Point>;using Nef=CGAL::Nef_polyhedron_3<K>;using Tri=std::array<std::size_t,3>;
namespace PMP=CGAL::Polygon_mesh_processing;
constexpr std::size_t MaxSolids=VolumePartitionLimits::SourceSolids,MaxRegions=VolumePartitionLimits::Regions,MaxInput=VolumePartitionLimits::InputTriangles,MaxBoundaryTriangles=VolumePartitionLimits::BoundaryTriangles,MaxNefVertices=VolumePartitionLimits::NefVertices;
void require(bool b,const char* code,const char* message){if(!b)throw occweb::DiscreteSurfaceError(code,message);}
J num(double n){return J(n);}J str(const std::string& s){return J(s);}J array(){return J::MakeArray();}J object(){return J::MakeObject();}
std::vector<Point> points(const J& value){std::vector<Point> out;for(const auto& p:value.AsArray())out.emplace_back(p.AsArray()[0].AsNumber(),p.AsArray()[1].AsNumber(),p.AsArray()[2].AsNumber());return out;}
std::vector<Tri> triangles(const J& value){std::vector<Tri> out;for(const auto& row:value.AsArray())out.push_back({std::size_t(row.AsArray()[0].AsInteger()),std::size_t(row.AsArray()[1].AsInteger()),std::size_t(row.AsArray()[2].AsInteger())});return out;}
K::Vector_3 normal(const std::vector<Point>& p,const Tri& t){return CGAL::cross_product(p[t[1]]-p[t[0]],p[t[2]]-p[t[0]]);}
Mesh meshFor(const std::vector<Point>& p,const std::vector<Tri>& t,const std::vector<int>& signs){Mesh mesh;std::map<std::size_t,Mesh::Vertex_index> index;for(std::size_t i=0;i<t.size();++i){if(!signs[i])continue;auto tri=t[i];if(signs[i]<0)std::swap(tri[1],tri[2]);std::array<Mesh::Vertex_index,3> vertices;for(int j=0;j<3;++j){auto found=index.find(tri[j]);if(found==index.end())found=index.emplace(tri[j],mesh.add_vertex(p[tri[j]])).first;vertices[j]=found->second;}require(mesh.add_face(vertices[0],vertices[1],vertices[2])!=Mesh::null_face(),"VOLUME_NON_MANIFOLD","A source/region boundary cannot form one oriented manifold surface.");}require(mesh.number_of_faces()>0&&CGAL::is_closed(mesh)&&CGAL::is_triangle_mesh(mesh),"VOLUME_OPEN_BOUNDARY","A source/region has an open or missing boundary.");require(PMP::does_bound_a_volume(mesh),"VOLUME_ORIENTATION_INVALID","Boundary does not consistently bound a volume.");require(PMP::volume(mesh)>K::FT(0),"VOLUME_ORIENTATION_INVALID","Boundary has no positive bounded volume.");return mesh;}
void bounded(const Nef& n){require(n.is_bounded()&&n.number_of_vertices()<=MaxNefVertices,"VOLUME_DOMAIN_LIMIT","Unbounded set or Nef vertex budget exceeded.");}
std::size_t components(const Nef& n){std::size_t count=0;for(auto it=n.volumes_begin();it!=n.volumes_end();++it)if(it->mark())++count;return count;}
struct Source{std::string body,solid;Nef set;K::FT volume;};
struct Region{Nef set;std::set<std::size_t> sources;K::FT volume;std::size_t components=0;};
struct Cell{Nef set;std::size_t region;K::FT volume;std::size_t shells;};
std::vector<Cell> connectedCellsFor(const Nef& domain){
 // Convert only one marked SNC volume at a time. The pinned whole-Nef mesh
 // exporter does not correctly preserve all deeper disconnected nesting.
 std::vector<Cell> cells;Nef combined;
 for(auto volume=domain.volumes_begin();volume!=domain.volumes_end();++volume)if(volume->mark()){
  Nef cell;std::size_t shellCount=0;for(auto shell=volume->shells_begin();shell!=volume->shells_end();++shell){const Nef boundedShell(domain,Nef::SFace_const_handle(shell));bounded(boundedShell);if(shellCount==0)cell=boundedShell;else cell^=boundedShell;shellCount++;}
  cell=cell.regularization();bounded(cell);require(!cell.is_empty()&&cell.is_simple()&&components(cell)==1&&(cell-domain).is_empty(),"VOLUME_CELL_EXTRACTION_INVALID","SNC shells did not produce one bounded connected subset.");
  Mesh mesh;CGAL::convert_nef_polyhedron_to_polygon_mesh(cell,mesh,true);require(CGAL::is_closed(mesh)&&PMP::does_bound_a_volume(mesh)&&PMP::volume(mesh)>K::FT(0),"VOLUME_CELL_EXTRACTION_INVALID","Connected cell boundary or cavity orientation is invalid.");
  require(cells.size()<VolumePartitionLimits::Cells,"VOLUME_CELL_LIMIT","Connected-cell extraction exceeds 128 cells.");for(const auto& old:cells)require((old.set*cell).regularization().is_empty(),"VOLUME_CELL_OVERLAP","Extracted cells overlap in volume.");
  combined+=cell;cells.push_back({cell,0,PMP::volume(mesh),shellCount});
 }
 require(!cells.empty()&&cells.size()==components(domain)&&combined==domain,"VOLUME_CELL_COVERAGE","Connected cells do not exactly reconstruct their source set.");return cells;
}
K::FT signedTriangleVolume(const std::vector<Point>& p,const Tri& t,int sign){const auto& a=p[t[0]];const auto& b=p[t[1]];const auto& c=p[t[2]];return sign*(a.x()*(b.y()*c.z()-b.z()*c.y())+a.y()*(b.z()*c.x()-b.x()*c.z())+a.z()*(b.x()*c.y()-b.y()*c.x()))/K::FT(6);}
J exportShells(const std::vector<Point>& p,const std::vector<Tri>& t,const std::vector<int>& signs,bool oneOuter=true){
 std::map<std::pair<std::size_t,std::size_t>,std::vector<std::size_t>> edges;
 for(std::size_t i=0;i<t.size();++i)if(signs[i])for(int j=0;j<3;++j)edges[std::minmax(t[i][j],t[i][(j+1)%3])].push_back(i);
 std::vector<std::vector<std::size_t>> adjacency(t.size());for(const auto& e:edges){require(e.second.size()==2,"VOLUME_CELL_OPEN_SHELL","A connected-cell shell edge does not have exactly two triangle uses.");adjacency[e.second[0]].push_back(e.second[1]);adjacency[e.second[1]].push_back(e.second[0]);}
 std::set<std::size_t> visited;J shells=array();std::size_t outerCount=0;
 for(std::size_t first=0;first<t.size();++first)if(signs[first]&&!visited.count(first)){std::queue<std::size_t> pending;pending.push(first);visited.insert(first);auto row=object(),ids=array();K::FT volume(0);while(!pending.empty()){const auto i=pending.front();pending.pop();ids.ChangeArray().push_back(num(double(i)));volume+=signedTriangleVolume(p,t[i],signs[i]);for(const auto next:adjacency[i])if(visited.insert(next).second)pending.push(next);}require(volume!=K::FT(0),"VOLUME_CELL_ZERO_SHELL","A cell shell has zero signed volume.");const bool outer=volume>K::FT(0);if(outer)outerCount++;row.ChangeObject()["triangleIndexes"]=std::move(ids);row.ChangeObject()["signedVolume"]=num(CGAL::to_double(volume));row.ChangeObject()["outer"]=J(outer);shells.ChangeArray().push_back(std::move(row));}
 require(oneOuter?outerCount==1:outerCount>0,"VOLUME_CELL_DISCONNECTED","A connected cell must have one outer shell; a source requires a positive outer shell.");std::stable_sort(shells.ChangeArray().begin(),shells.ChangeArray().end(),[](const J& a,const J& b){return a.At("outer").AsBoolean()>b.At("outer").AsBoolean();});return shells;
}
Nef sourceSetFor(const std::vector<Point>& p,const std::vector<Tri>& t,const std::vector<int>& signs,const K::FT& expectedVolume){
 // Nef(PolygonMesh) calls mark_bounded_volumes(): constructing one Nef from
 // several nested shells fills cavities regardless of their orientation.
 // Construct each connected shell as a bounded set, then exact symmetric
 // difference restores nesting parity without centroid or proximity probes.
 const auto shells=exportShells(p,t,signs,false);require(shells.AsArray().size()<=VolumePartitionLimits::Cells,"VOLUME_SOURCE_SHELL_LIMIT","Source shell inventory exceeds 128 closed shells.");Nef result;
 bool first=true;for(const auto& shell:shells.AsArray()){
  std::vector<int> selected(t.size(),0);const int direction=shell.At("outer").AsBoolean()?1:-1;
  for(const auto& index:shell.At("triangleIndexes").AsArray()){const auto i=std::size_t(index.AsInteger());selected[i]=direction*signs[i];}
  const Nef boundedShell(meshFor(p,t,selected));bounded(boundedShell);if(first){result=boundedShell;first=false;}else result^=boundedShell;bounded(result);
 }
 result=result.regularization();require(!result.is_empty()&&result.is_simple(),"VOLUME_SOURCE_INVALID","Source shells do not form a simple bounded set.");K::FT actualVolume(0);for(const auto& cell:connectedCellsFor(result))actualVolume+=cell.volume;
 require(actualVolume==expectedVolume,"VOLUME_SOURCE_SHELL_ORIENTATION","Exact connected source shells do not conserve the source's oriented volume.");return result;
}
std::string key(const J& source){return source.GetString("bodyId")+"/"+source.GetString("solidId");}
}
J PartitionSourceVolumes(const J& input, bool constrainSheets){
 require(input.IsObject(),"VOLUME_INPUT_INVALID","One discrete surface object is required.");
 for(const auto& field:input.AsObject())require(field.first=="units"||field.first=="points"||field.first=="triangles"||field.first=="sources"||field.first=="options","VOLUME_INPUT_INVALID","Unknown volume input field.");
 require(input.At("triangles").AsArray().size()<=MaxInput&&input.At("points").AsArray().size()<=VolumePartitionLimits::Points,"VOLUME_INPUT_LIMIT","Volume input exceeds 4096 triangles or 60000 points.");
 // Validate and repair with the existing pinned component BEFORE consuming indices.
 const J refined=occweb::RefineDiscreteSurface(input);const auto originalPoints=points(input.At("points")),p=points(refined.At("points"));const auto originalTriangles=triangles(input.At("triangles")),t=triangles(refined.At("triangles"));
 const auto& labels=input.At("sources").AsArray();std::map<std::string,std::size_t> sourceIndex;std::vector<Source> sources;
 std::set<std::string> sheetFaces;
 for(const auto& label:labels){if(!label.Has("solidId")){require(constrainSheets,"VOLUME_FREE_SHEET_UNSUPPORTED","Free Sheets do not define bounded volume membership; they are not silently discarded.");sheetFaces.insert(label.GetString("bodyId")+"/"+label.GetString("faceId"));continue;}require(!label.GetString("solidId").empty(),"VOLUME_INPUT_INVALID","An explicit solidId cannot be empty.");const auto k=key(label);if(!sourceIndex.count(k)){require(sources.size()<MaxSolids,"VOLUME_SOLID_LIMIT","Volume partition supports at most six explicitly labeled source Solids.");sourceIndex[k]=sources.size();sources.push_back({label.GetString("bodyId"),label.GetString("solidId"),Nef(),K::FT(0)});}}
 require(!sources.empty(),"VOLUME_SOLID_REQUIRED","A constrained volume partition requires at least one closed source Solid; open Sheets are not promoted to volumes.");
 std::vector<std::vector<int>> signs(sources.size(),std::vector<int>(t.size(),0));
 for(std::size_t i=0;i<t.size();++i){const auto n=normal(p,t[i]);for(const auto& ref:refined.At("sourceTriangleIds").AsArray()[i].AsArray()){const auto j=std::size_t(ref.AsInteger());if(!labels[j].Has("solidId"))continue;const auto owner=sourceIndex.at(key(labels[j]));const auto dot=n*normal(originalPoints,originalTriangles[j]);require(dot!=K::FT(0),"VOLUME_ORIENTATION_INVALID","Source normal is ambiguous after surface repair.");const int sign=dot>K::FT(0)?1:-1;require(!signs[owner][i]||signs[owner][i]==sign,"VOLUME_ORIENTATION_CONFLICT","Coincident source uses have conflicting orientation.");signs[owner][i]=sign;}}
 for(std::size_t i=0;i<sources.size();++i){auto mesh=meshFor(p,t,signs[i]);sources[i].volume=PMP::volume(mesh);sources[i].set=sourceSetFor(p,t,signs[i],sources[i].volume);bounded(sources[i].set);require(!sources[i].set.is_empty()&&sources[i].set.is_simple(),"VOLUME_SOURCE_INVALID","Source does not define a simple bounded closed set.");}
 std::vector<Region> regions;
 for(std::size_t i=0;i<sources.size();++i){Nef remaining=sources[i].set;std::vector<Region> next;
  for(const auto& old:regions){auto inside=(old.set*sources[i].set).regularization(),outside=(old.set-sources[i].set).regularization();bounded(inside);bounded(outside);if(!outside.is_empty())next.push_back({outside,old.sources,K::FT(0)});if(!inside.is_empty()){auto owner=old.sources;owner.insert(i);next.push_back({inside,std::move(owner),K::FT(0)});}remaining=(remaining-old.set).regularization();bounded(remaining);require(next.size()<=MaxRegions,"VOLUME_REGION_LIMIT","Partition exceeds 32 membership regions.");}
  if(!remaining.is_empty())next.push_back({remaining,{i},K::FT(0)});require(next.size()<=MaxRegions,"VOLUME_REGION_LIMIT","Partition exceeds 32 membership regions.");regions=std::move(next);
 }
 // Prove set coverage per input and pairwise zero-volume overlap exactly.
 for(std::size_t i=0;i<regions.size();++i)for(std::size_t j=i+1;j<regions.size();++j)require((regions[i].set*regions[j].set).regularization().is_empty(),"VOLUME_PARTITION_OVERLAP","Partition regions still overlap in volume.");
 for(std::size_t s=0;s<sources.size();++s){Nef reconstructed;for(const auto& region:regions)if(region.sources.count(s))reconstructed+=region.set;require(reconstructed==sources[s].set,"VOLUME_PARTITION_COVERAGE","Exact partition does not reconstruct an original source set.");}
 // Use the already conformal input arrangement directly. Converting Nef
 // vertices back to double and refining them a second time can manufacture
 // microscopic facets; exact set tests avoid that conversion and retain faces.
 std::vector<Cell> cells;
 for(std::size_t r=0;r<regions.size();++r){auto& region=regions[r];require(region.set.is_simple(),"VOLUME_REGION_NON_SIMPLE","A membership region needs separate non-simple domain handling.");auto pieces=connectedCellsFor(region.set);region.volume=K::FT(0);region.components=pieces.size();for(auto& cell:pieces){require(cells.size()<VolumePartitionLimits::Cells,"VOLUME_CELL_LIMIT","Connected-cell export exceeds 128 cells.");region.volume+=cell.volume;cell.region=r;cells.push_back(std::move(cell));}require(region.volume>K::FT(0)&&region.components>0,"VOLUME_REGION_INVALID","Region has no positive bounded volume.");
 }
 const J conformal=refined;const auto& cp=p;const auto& ct=t;
 require(cp.size()<=VolumePartitionLimits::Points&&ct.size()<=MaxBoundaryTriangles&&ct.size()*cells.size()<=VolumePartitionLimits::ClassificationPairs,"VOLUME_CLASSIFICATION_LIMIT","Exact triangle/cell classification exceeds its point, triangle or work budget.");
 std::vector<Nef> boundarySets;for(const auto& cell:cells)boundarySets.push_back(cell.set.boundary());
 std::vector<std::vector<int>> regionSigns(regions.size(),std::vector<int>(ct.size(),0)),cellSigns(cells.size(),std::vector<int>(ct.size(),0));J uses=array(),cellUses=array(),constraintRows=array(),originalRefs=refined.At("sourceTriangleIds");std::size_t shared=0,embeddedCount=0,exteriorCount=0,boundarySheetCount=0;
 for(std::size_t i=0;i<ct.size();++i){
  const std::vector<Point> corners={cp[ct[i][0]],cp[ct[i][1]],cp[ct[i][2]]};const Nef triangleSet(corners.begin(),corners.end());auto row=array(),cellRow=array(),embedded=array();int count=0,sum=0;bool hasSolidSource=false,hasSheetSource=false;
  for(const auto& ref:originalRefs.AsArray()[i].AsArray()){if(labels[std::size_t(ref.AsInteger())].Has("solidId"))hasSolidSource=true;else hasSheetSource=true;}
  for(std::size_t c=0;c<cells.size();++c){const auto r=cells[c].region;
   const bool onBoundary=(triangleSet-boundarySets[c]).is_empty();
   if(!onBoundary){const auto overlap=triangleSet*cells[c].set;bool hasArea=false;for(auto facet=overlap.halffacets_begin();facet!=overlap.halffacets_end();++facet)hasArea=hasArea||facet->mark();if(hasArea){const bool contained=(triangleSet-cells[c].set).is_empty();if(!(constrainSheets&&hasSheetSource&&!hasSolidSource&&contained))throw occweb::DiscreteSurfaceError("VOLUME_BOUNDARY_SPLIT_REQUIRED","Arrangement triangle "+std::to_string(i)+" intersects cell "+std::to_string(c)+" away from its boundary (solid source="+std::to_string(hasSolidSource)+", Sheet source="+std::to_string(hasSheetSource)+", contained="+std::to_string(contained)+"); no guessed classification.");embedded.ChangeArray().push_back(num(double(c)));}continue;}
   const auto n=normal(cp,ct[i]);int sign=0;
   for(const auto& ref:originalRefs.AsArray()[i].AsArray()){const auto j=std::size_t(ref.AsInteger());if(!labels[j].Has("solidId"))continue;const auto owner=sourceIndex.at(key(labels[j]));const auto dot=n*normal(originalPoints,originalTriangles[j]);require(dot!=K::FT(0),"VOLUME_INTERFACE_ORIENTATION","Original source normal is ambiguous.");const int candidate=(dot>K::FT(0)?1:-1)*(regions[r].sources.count(owner)?1:-1);require(!sign||sign==candidate,"VOLUME_INTERFACE_ORIENTATION","Original source membership gives conflicting boundary directions.");sign=candidate;}
   require(sign!=0&&!regionSigns[r][i],"VOLUME_FACE_SOURCE_MISSING","A connected boundary lacks a unique region/source use.");regionSigns[r][i]=sign;cellSigns[c][i]=sign;auto use=object(),cellUse=object();use.ChangeObject()["regionIndex"]=num(double(r));use.ChangeObject()["orientation"]=num(sign);cellUse.ChangeObject()["cellIndex"]=num(double(c));cellUse.ChangeObject()["orientation"]=num(sign);row.ChangeArray().push_back(std::move(use));cellRow.ChangeArray().push_back(std::move(cellUse));count++;sum+=sign;
  }
  if(count){require(count<=2&&(count!=2||sum==0)&&embedded.AsArray().empty(),"VOLUME_INTERFACE_CONFLICT","A boundary must have one cell use or two opposite uses, not an embedded use.");if(count==2)shared++;if(hasSheetSource)boundarySheetCount++;}
  else{require(constrainSheets&&hasSheetSource&&!hasSolidSource&&embedded.AsArray().size()<=1,"VOLUME_INTERFACE_CONFLICT","A non-boundary triangle must be an explicit Sheet with at most one containing closed cell.");if(embedded.AsArray().empty())exteriorCount++;else embeddedCount++;}
  auto constraint=object();constraint.ChangeObject()["kind"]=str(count?"boundary":embedded.AsArray().empty()?"exterior":"embedded");constraint.ChangeObject()["cellIndexes"]=std::move(embedded);constraintRows.ChangeArray().push_back(std::move(constraint));uses.ChangeArray().push_back(std::move(row));cellUses.ChangeArray().push_back(std::move(cellRow));
 }
 auto regionRows=array(),sourceRows=array();K::FT total(0);std::vector<K::FT> sourceVolumes(sources.size(),K::FT(0));double maxVolumeError=0;
 for(std::size_t i=0;i<regions.size();++i){const auto mesh=meshFor(cp,ct,regionSigns[i]);const auto volume=PMP::volume(mesh);const double exact=CGAL::to_double(regions[i].volume),actual=CGAL::to_double(volume),error=std::abs(actual-exact)/std::max(1e-30,std::abs(exact));require(std::isfinite(error)&&error<=1e-8,"VOLUME_NUMERIC_DRIFT","Shared double boundary changed a region volume beyond tolerance.");maxVolumeError=std::max(maxVolumeError,error);total+=volume;auto row=object(),owners=array();for(auto owner:regions[i].sources){owners.ChangeArray().push_back(num(double(owner)));sourceVolumes[owner]+=volume;}row.ChangeObject()["sourceSolidIndexes"]=std::move(owners);row.ChangeObject()["volume"]=num(actual);row.ChangeObject()["exactPartitionVolume"]=num(exact);row.ChangeObject()["connectedVolumeCount"]=num(double(regions[i].components));row.ChangeObject()["closed"]=J(true);regionRows.ChangeArray().push_back(std::move(row));}
 for(std::size_t i=0;i<sources.size();++i){const double original=CGAL::to_double(sources[i].volume),partition=CGAL::to_double(sourceVolumes[i]);require(std::abs(original-partition)<=1e-8*std::max(1e-30,std::abs(original)),"VOLUME_NUMERIC_COVERAGE","Final boundaries do not conserve an original Solid volume.");auto row=object();row.ChangeObject()["bodyId"]=str(sources[i].body);row.ChangeObject()["solidId"]=str(sources[i].solid);row.ChangeObject()["volume"]=num(original);row.ChangeObject()["partitionVolume"]=num(partition);sourceRows.ChangeArray().push_back(std::move(row));}
 auto cellRows=array();std::vector<K::FT> cellRegionVolumes(regions.size(),K::FT(0));for(std::size_t c=0;c<cells.size();++c){const auto mesh=meshFor(cp,ct,cellSigns[c]);const auto volume=PMP::volume(mesh);require(CGAL::abs(volume-cells[c].volume)<=CGAL::abs(cells[c].volume)*K::FT(1e-8),"VOLUME_CELL_VOLUME_MISMATCH","Connected-cell triangles changed its exact volume.");cellRegionVolumes[cells[c].region]+=volume;auto row=object();row.ChangeObject()["regionIndex"]=num(double(cells[c].region));row.ChangeObject()["sourceSolidIndexes"]=regionRows.AsArray()[cells[c].region].At("sourceSolidIndexes");row.ChangeObject()["volume"]=num(CGAL::to_double(volume));row.ChangeObject()["closed"]=J(true);row.ChangeObject()["shells"]=exportShells(cp,ct,cellSigns[c]);require(row.At("shells").AsArray().size()==cells[c].shells,"VOLUME_CELL_SHELL_MISMATCH","Triangular shells disagree with exact SNC cell shells.");cellRows.ChangeArray().push_back(std::move(row));}for(std::size_t r=0;r<regions.size();++r)require(cellRegionVolumes[r]==regions[r].volume,"VOLUME_CELL_VOLUME_MISMATCH","Connected-cell volumes do not exactly cover a region.");
 auto result=object(),report=object();result.ChangeObject()["ok"]=J(true);result.ChangeObject()["basis"]=str("exact-nef-membership-partition-shared-refined-boundary-v1");result.ChangeObject()["cgalVersion"]=str(CGAL_VERSION_STR);result.ChangeObject()["units"]=str("mm");result.ChangeObject()["sourceSolids"]=std::move(sourceRows);result.ChangeObject()["regions"]=std::move(regionRows);result.ChangeObject()["cells"]=std::move(cellRows);result.ChangeObject()["points"]=conformal.At("points");result.ChangeObject()["triangles"]=conformal.At("triangles");result.ChangeObject()["triangleRegionUses"]=std::move(uses);result.ChangeObject()["triangleCellUses"]=std::move(cellUses);result.ChangeObject()["sourceTriangleIds"]=std::move(originalRefs);result.ChangeObject()["sources"]=input.At("sources");
 report.ChangeObject()["regionCount"]=num(double(regions.size()));report.ChangeObject()["sharedInterfaceTriangles"]=num(double(shared));report.ChangeObject()["unionVolume"]=num(CGAL::to_double(total));report.ChangeObject()["maxRelativeRegionVolumeError"]=num(maxVolumeError);report.ChangeObject()["exactSetCoverage"]=J(true);report.ChangeObject()["pairwiseVolumeDisjoint"]=J(true);report.ChangeObject()["allRegionBoundariesClosed"]=J(true);report.ChangeObject()["tetrahedralReady"]=J(false);report.ChangeObject()["normalMeshAdmitted"]=J(false);report.ChangeObject()["sourceIdentityAuthority"]=str("caller-supplied-solid-labels-not-cad-certificates");report.ChangeObject()["connectedCellsIndividuallyExported"]=J(true);report.ChangeObject()["cellCount"]=num(double(cells.size()));result.ChangeObject()["report"]=std::move(report);result.ChangeObject()["surfaceReport"]=refined.At("report");
 if(constrainSheets){result.ChangeObject()["basis"]=str("exact-nef-membership-with-open-sheet-constraints-v1");auto constraints=object(),summary=object();constraints.ChangeObject()["version"]=num(1);constraints.ChangeObject()["basis"]=str("exact-triangle-closed-cell-membership-v1");constraints.ChangeObject()["triangles"]=std::move(constraintRows);summary.ChangeObject()["embeddedTriangles"]=num(double(embeddedCount));summary.ChangeObject()["exteriorTriangles"]=num(double(exteriorCount));summary.ChangeObject()["boundarySheetTriangles"]=num(double(boundarySheetCount));summary.ChangeObject()["sheetSourceFaces"]=num(double(sheetFaces.size()));constraints.ChangeObject()["report"]=std::move(summary);result.ChangeObject()["constraints"]=std::move(constraints);}
 return result;
}
