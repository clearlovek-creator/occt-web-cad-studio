#pragma once
#include "FeatureNode.hxx"
#include "../document/CadError.hxx"
#include <cmath>

namespace occweb
{
inline std::string PatternSlot(const FeatureNode& feature,const std::size_t index)
{
  if(feature.Type!="pattern.rectangular")return "index:"+std::to_string(index);
  const auto found=feature.NumberParameters.find("countX");
  if(found==feature.NumberParameters.end() || !std::isfinite(found->second) || found->second<1 || found->second>20 || found->second!=std::round(found->second))
    throw CadError("INVALID_PARAMETER","Rectangular pattern columns must be integers between 1 and 20.");
  const auto columns=static_cast<std::size_t>(found->second);
  return "row:"+std::to_string(index/columns)+",column:"+std::to_string(index%columns);
}
inline void CapturePatternSlots(FeatureNode& feature)
{
  if(feature.Type.rfind("pattern.",0)!=0)return;
  for(std::size_t index=0;index<feature.OutputBodies.size();++index)
    feature.StringParameters.emplace("patternSlot."+feature.OutputBodies[index],PatternSlot(feature,index));
}
}
