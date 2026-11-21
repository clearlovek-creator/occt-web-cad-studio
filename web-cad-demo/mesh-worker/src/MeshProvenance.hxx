#pragma once
#include "protocol/Json.hxx"
#include <map>
#include <string>
#include <vector>

namespace occweb {
struct PreparedVolumeSource {std::string BodyId;int SourceSolidIndex;};
struct PreparedMeshMapping {
  JsonValue Manifest;
  std::vector<int> VolumeTags,SurfaceTags;
  std::map<int,std::vector<PreparedVolumeSource>> VolumeSources;
  std::map<int,JsonValue> SurfaceSources;
};
bool IsPreparedMesh(const JsonValue& parameters);
PreparedMeshMapping ImportPreparedMesh(const std::string& path,const JsonValue& manifest);
std::string PreparedSurfaceSourcesJson(const PreparedMeshMapping&,int surfaceTag);
std::string PreparedBoundaryJson(const PreparedMeshMapping&);
}
