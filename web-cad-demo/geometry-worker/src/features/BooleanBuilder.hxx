#pragma once
#include <TopoDS_Shape.hxx>
#include <BRepTools_History.hxx>
#include <string>
#include <vector>
namespace occweb
{
struct BooleanBuildResult { TopoDS_Shape Shape; Handle(BRepTools_History) History; };
BooleanBuildResult BuildBooleanOperation(const std::string& operation,const std::vector<TopoDS_Shape>& targets,const std::vector<TopoDS_Shape>& tools,bool refine);
}
