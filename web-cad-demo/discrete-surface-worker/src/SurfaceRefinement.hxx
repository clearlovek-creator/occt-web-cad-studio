// SPDX-License-Identifier: GPL-3.0-or-later
#pragma once
#include "protocol/Json.hxx"
#include <cstddef>
#include <stdexcept>
#include <string>
#include <utility>
namespace occweb
{
struct DiscreteSurfaceLimits
{
  static constexpr std::size_t InputTriangles=20000,OutputTriangles=200000,Points=600000,
    OwnerReferences=1000000,RequestBytes=8u*1024u*1024u,ResponseBytes=64u*1024u*1024u;
};
struct DiscreteSurfaceError:std::runtime_error
{
  std::string Code;
  DiscreteSurfaceError(std::string code,std::string message):std::runtime_error(std::move(message)),Code(std::move(code)){}
};
JsonValue RefineDiscreteSurface(const JsonValue& request);
}
