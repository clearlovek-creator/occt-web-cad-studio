#pragma once
#include <TopoDS_Shape.hxx>
#include <string>
#include <cstddef>
namespace occweb
{
// Exact serialized BRep identity, deliberately not a geometric proximity test.
struct ShapeFingerprintStats { std::size_t SerializedBytes=0,PeakBufferedBytes=0; };
std::string ShapeFingerprint(const TopoDS_Shape& shape,ShapeFingerprintStats* stats=nullptr);
// Stable bounded semantic keys; same SHA256 implementation as BRep evidence.
std::string StableDigest(const std::string& bytes);
}
