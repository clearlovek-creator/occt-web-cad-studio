#include "BooleanBuilder.hxx"
#include "../document/CadError.hxx"
#include <BOPAlgo_Splitter.hxx>
#include <BRepAlgoAPI_Common.hxx>
#include <BRepAlgoAPI_Cut.hxx>
#include <BRepAlgoAPI_Fuse.hxx>
#include <BRepAlgoAPI_Section.hxx>
#include <BRepCheck_Analyzer.hxx>
#include <ShapeUpgrade_UnifySameDomain.hxx>
#include <set>
namespace {
template<class Builder>
void buildPair(Builder& builder, const TopoDS_Shape& target, const TopoDS_Shape& tool)
{
  NCollection_List<TopoDS_Shape> arguments, tools;
  arguments.Append(target); tools.Append(tool);
  builder.SetArguments(arguments); builder.SetTools(tools);
  builder.SetNonDestructive(true); builder.SetToFillHistory(true); builder.Build();
}

TopoDS_Shape fuseAll(const std::vector<TopoDS_Shape>& shapes, Handle(BRepTools_History)& history)
{
  if (shapes.empty()) return {};
  TopoDS_Shape result = shapes.front();
  for (std::size_t index = 1; index < shapes.size(); ++index)
  {
    BRepAlgoAPI_Fuse builder;
    buildPair(builder, result, shapes[index]);
    if (!builder.IsDone())
      throw occweb::CadError("BUILD_FAILED", "OCCT could not combine the Boolean input group.");
    result = builder.Shape();
    history->Merge(builder.History());
  }
  return result;
}

TopoDS_Shape runBoolean(const std::string& operation,
                        const std::vector<TopoDS_Shape>& targets,
                        const std::vector<TopoDS_Shape>& tools,
                        Handle(BRepTools_History)& history)
{
  // Compose group Fuse -> Boolean -> Refine history. Never infer lineage from
  // subshape enumeration: even an unchanged face can acquire a different index.
  const bool pairOperation = operation == "boolean.fuse" || operation == "boolean.cut"
    || operation == "boolean.common" || operation == "boolean.section";
  const TopoDS_Shape target = pairOperation ? fuseAll(targets, history) : TopoDS_Shape();
  const TopoDS_Shape tool = pairOperation ? fuseAll(tools, history) : TopoDS_Shape();
  TopoDS_Shape result;
  if (operation == "boolean.fuse")
  {
    BRepAlgoAPI_Fuse builder; buildPair(builder, target, tool);
    if (!builder.IsDone()) throw occweb::CadError("BUILD_FAILED", "OCCT could not build the Fuse result.");
    result = builder.Shape();
    history->Merge(builder.History());
  }
  else if (operation == "boolean.cut")
  {
    BRepAlgoAPI_Cut builder; buildPair(builder, target, tool);
    if (!builder.IsDone()) throw occweb::CadError("BUILD_FAILED", "OCCT could not build the Cut result.");
    result = builder.Shape();
    history->Merge(builder.History());
  }
  else if (operation == "boolean.common")
  {
    BRepAlgoAPI_Common builder; buildPair(builder, target, tool);
    if (!builder.IsDone()) throw occweb::CadError("BUILD_FAILED", "OCCT could not build the Common result.");
    result = builder.Shape();
    history->Merge(builder.History());
  }
  else if (operation == "boolean.section")
  {
    BRepAlgoAPI_Section builder(target, tool, false); builder.SetNonDestructive(true); builder.SetToFillHistory(true); builder.Approximation(true); builder.Build();
    if (!builder.IsDone()) throw occweb::CadError("BUILD_FAILED", "OCCT could not build the Section result.");
    result = builder.Shape();
    history->Merge(builder.History());
  }
  else
  {
    BOPAlgo_Splitter splitter;
    if (operation == "boolean.fragments")
    {
      for (const TopoDS_Shape& shape : targets) splitter.AddArgument(shape);
      for (const TopoDS_Shape& shape : tools) splitter.AddArgument(shape);
    }
    else
    {
      for (const TopoDS_Shape& shape : targets) splitter.AddArgument(shape);
      for (const TopoDS_Shape& shape : tools) splitter.AddTool(shape);
    }
    splitter.SetNonDestructive(true);
    splitter.SetToFillHistory(true);
    splitter.Perform();
    if (splitter.HasErrors())
      throw occweb::CadError("BUILD_FAILED", "OCCT could not build the split/fragments result.");
    result = splitter.Shape();
    history->Merge(splitter.History());
  }
  if (result.IsNull()) throw occweb::CadError("BUILD_FAILED", "The Boolean result is empty.");
  return result;
}

}
namespace occweb {
BooleanBuildResult BuildBooleanOperation(const std::string& operation,const std::vector<TopoDS_Shape>& targets,const std::vector<TopoDS_Shape>& tools,bool refine) {
  static const std::set<std::string> supported={"boolean.fuse","boolean.cut","boolean.common","boolean.section","boolean.split","boolean.partition","boolean.fragments","boolean.imprint"};
  if(!supported.count(operation))throw CadError("UNKNOWN_OPERATION","Unsupported Boolean operation: "+operation);
  Handle(BRepTools_History) history=new BRepTools_History;
  TopoDS_Shape shape=runBoolean(operation,targets,tools,history);
  if(refine && operation!="boolean.section") {ShapeUpgrade_UnifySameDomain unify(shape,true,true,true);unify.SetSafeInputMode(true);unify.Build();if(!unify.Shape().IsNull()){shape=unify.Shape();history->Merge(unify.History());}}
  if(shape.IsNull() || !BRepCheck_Analyzer(shape).IsValid())throw CadError("INVALID_RESULT","The Boolean result is invalid.");
  return {shape,history};
}
}
