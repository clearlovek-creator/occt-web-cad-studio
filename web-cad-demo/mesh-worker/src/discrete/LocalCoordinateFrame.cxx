// SPDX-License-Identifier: GPL-3.0-or-later
#include "LocalCoordinateFrame.hxx"
#include <gmsh.h>
#include <cmath>

namespace occweb::discrete {
Point LocalCoordinateFrame::local(const Point& point) const {
  Point result;
  for(int i=0;i<3;++i)result[i]=point[i]-origin_[i];
  return result;
}
Point LocalCoordinateFrame::world(const Point& point) const {
  Point result;
  for(int i=0;i<3;++i){
    result[i]=point[i]+origin_[i];
    if(!std::isfinite(result[i])||std::abs(result[i])>1e12)
      throw QualityError("MESH_COORDINATE_PRECISION","Published mesh coordinates exceed the supported world frame.");
  }
  return result;
}
Point LocalCoordinateFrame::canonical(const Point& point) const {
  const auto result=local(world(point));
  Point delta;
  for(int i=0;i<3;++i)delta[i]=result[i]-point[i];
  // Match the independent gateway's fixed boundary-plane accuracy, never inflate it
  // according to the distance from the origin or silently change the quality gate.
  if(std::hypot(delta[0],delta[1],delta[2])>1e-8)
    throw QualityError("MESH_COORDINATE_PRECISION","World-coordinate rounding exceeds mesh boundary accuracy; move the model closer to the origin.");
  return result;
}
void LocalCoordinateFrame::canonicalizeMesh() const {
  std::vector<std::size_t> tags;
  std::vector<double> xyz,parameters;
  gmsh::model::mesh::getNodes(tags,xyz,parameters,-1,-1,false,false);
  if(tags.size()>100000||xyz.size()!=3*tags.size())
    throw QualityError("MESH_OUTPUT_LIMIT","Coordinate canonicalization exceeds the bounded mesh inventory.");
  for(std::size_t i=0;i<tags.size();++i){
    const Point current={xyz[3*i],xyz[3*i+1],xyz[3*i+2]},next=canonical(current);
    if(next!=current){
      std::vector<double> saved,uv;int dimension,entity;
      gmsh::model::mesh::getNode(tags[i],saved,uv,dimension,entity);
      gmsh::model::mesh::setNode(tags[i],{next[0],next[1],next[2]},uv);
    }
  }
}
} // namespace occweb::discrete
