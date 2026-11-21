#pragma once
#include <optional>
#include <string>

namespace occweb
{
struct BodyRecord;
struct FeatureNode;
double ValidatedBodyOpacity(double value);
std::string FormatBodyOpacity(double value);
std::optional<double> StoredBodyOpacity(const FeatureNode& feature,const std::string& role,const std::string& bodyId);
void StoreBodyDisplayMetadata(FeatureNode& feature,const std::string& role,const BodyRecord& body);
}
