#include "BodyDisplayMetadata.hxx"
#include "CadDocument.hxx"
#include "CadError.hxx"
#include <charconv>
#include <cmath>

namespace occweb
{
double ValidatedBodyOpacity(double value)
{
  if(!std::isfinite(value)||value<0.05||value>1.0)
    throw CadError("INVALID_BODY_OPACITY","Body opacity must be between 0.05 and 1.0.");
  return value;
}
std::string FormatBodyOpacity(double value)
{
  char bytes[64];const auto encoded=std::to_chars(bytes,bytes+sizeof(bytes),ValidatedBodyOpacity(value));
  if(encoded.ec!=std::errc{})throw CadError("INVALID_BODY_OPACITY","Body opacity could not be encoded.");
  return std::string(bytes,encoded.ptr);
}
std::optional<double> StoredBodyOpacity(const FeatureNode& feature,const std::string& role,const std::string& bodyId)
{
  const auto found=feature.StringParameters.find(role+"."+bodyId+".opacity");
  if(found==feature.StringParameters.end())return {};
  // Legacy std::to_string decimals and new lossless decimals are both read.
  // Bound parsing and reject malformed evidence instead of clamping it.
  try{
    if(found->second.empty()||found->second.size()>64)throw JsonError("Invalid stored opacity.");
    const auto value=JsonParser(found->second).Parse();
    if(!value.IsNumber())throw JsonError("Stored opacity must be numeric.");
    return ValidatedBodyOpacity(value.AsNumber());
  }catch(const JsonError&){throw CadError("INVALID_BODY_OPACITY","Stored Body opacity is malformed.");}
}
void StoreBodyDisplayMetadata(FeatureNode& feature,const std::string& role,const BodyRecord& body)
{
  const auto prefix=role+"."+body.Id+".";
  const auto opacity=FormatBodyOpacity(body.Opacity);
  feature.StringParameters[prefix+"name"]=body.Name;
  feature.StringParameters[prefix+"visible"]=body.Visible?"true":"false";
  feature.StringParameters[prefix+"color"]=body.Color;
  feature.StringParameters[prefix+"material"]=body.Material;
  feature.StringParameters[prefix+"opacity"]=opacity;
}
}
