#pragma once
#include "../protocol/Json.hxx"
#include <TopoDS_Shape.hxx>
#include <string>

namespace occweb
{
struct MeshPreparationBody;

// This function analyzes a caller-owned copy, never the live document's TShapes.
JsonValue DiagnoseMeshShape(const TopoDS_Shape& shape, const MeshPreparationBody* source,
                           double repairTolerance, bool deepCheck);

class MeshPreparationDiagnostics
{
public:
  MeshPreparationDiagnostics(std::string mode, bool deepCheck);
  void Before(const MeshPreparationBody& body, const TopoDS_Shape& copy);
  void After(const MeshPreparationBody& body, const TopoDS_Shape& repaired);
  void Complete(const TopoDS_Shape& prepared);
  void Failed(const std::string& code, const std::string& message);
  bool HasBlockingRepairErrors() const;
  std::string Serialize() const { return JsonSerialize(myReport); }
private:
  bool myDeepCheck;
  double myTolerance;
  JsonValue myReport;
};
}
