#pragma once
#include <TopoDS_Shape.hxx>
#include <Quantity_Color.hxx>
#include <TDF_Label.hxx>
#include <TDocStd_Document.hxx>
#include <string>
#include <vector>

namespace occweb {
struct StepImportedPart {
  TopoDS_Shape Shape;
  std::string Name;
  Quantity_Color Color;
  bool HasColor=false;
  bool Valid=false;
  TDF_Label Label;
};
struct StepImportResult {
  std::vector<StepImportedPart> Parts;
  std::vector<std::string> LengthUnits;
  std::string SourceFingerprint;
  int RootCount=0;
  int EmptyRoots=0;
  int AmbiguousSubshapeMetadata=0;
};
// v1 reproduces the old importer layout, not the old inconsistent replay path.
// v2 splits mixed solid products without dropping Sheet/Wire/Vertex; pure
// non-solid products retain their original grouping (e.g. a compound of Edges).
StepImportResult ReadStepParts(const std::string& path,int version=2,const std::string& expectedFingerprint="",const Handle(TDocStd_Document)& destination={});
}
