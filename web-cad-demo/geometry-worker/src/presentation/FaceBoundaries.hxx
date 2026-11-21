#pragma once
#include "ShapeSerializer.hxx"
#include "../protocol/Json.hxx"
namespace occweb
{
// Ephemeral display IDs in the supplied snapshot, never persistent selectors.
JsonValue FaceBoundaries(const ShapeSerializer& topology,int faceIndex);
JsonValue FaceBoundaryTable(const ShapeSerializer& topology);
}
