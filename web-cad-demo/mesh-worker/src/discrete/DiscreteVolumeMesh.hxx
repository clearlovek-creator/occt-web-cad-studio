// SPDX-License-Identifier: GPL-3.0-or-later
#pragma once
#include "protocol/Json.hxx"
#include <cstddef>
#include <array>
#include <vector>
namespace occweb::discrete {
struct Controls;
class LocalCoordinateFrame;
// Caller owns the Gmsh session and must use a dedicated one-job process.
JsonValue CreateVolumeMesh(const JsonValue& request, JsonValue* checkpoint = nullptr);
JsonValue CreateConstrainedVolumeMesh(const JsonValue& request);
JsonValue CreatePatchedVolumeMesh(const JsonValue& request, JsonValue* checkpoint = nullptr);
std::array<double,3> PreparePatchedVolumeDomain(const JsonValue& request);
JsonValue ExportPatchedVolumeMesh(const JsonValue& request, const Controls&, const JsonValue& optimization,
                                 const LocalCoordinateFrame&, std::vector<std::size_t>* pointNodeTags = nullptr);
void ConfigureVolumeMeshOptions(double meshSize);
JsonValue ExportVolumeMesh(const JsonValue& domain, const Controls&, const JsonValue& optimization,
                          const LocalCoordinateFrame&, std::vector<std::size_t>* pointNodeTags = nullptr);
}
