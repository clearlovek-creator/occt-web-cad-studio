#include "UserPropertyStore.hxx"

#include "CadError.hxx"

#include <cctype>
#include <cmath>
#include <iomanip>
#include <sstream>

namespace
{
std::string stringify(const occweb::JsonValue& value)
{
  using Type = occweb::JsonValue::Type;
  switch (value.GetType())
  {
    case Type::Null: return "null";
    case Type::Boolean: return value.AsBoolean() ? "true" : "false";
    case Type::Number:
    {
      std::ostringstream out;
      out << std::setprecision(17) << value.AsNumber();
      return out.str();
    }
    case Type::String: return "\"" + occweb::JsonEscape(value.AsString()) + "\"";
    case Type::Array:
    {
      std::ostringstream out;
      out << '[';
      bool first = true;
      for (const auto& item : value.AsArray())
      {
        if (!first) out << ',';
        out << stringify(item);
        first = false;
      }
      out << ']';
      return out.str();
    }
    case Type::Object:
    {
      std::ostringstream out;
      out << '{';
      bool first = true;
      for (const auto& [key, item] : value.AsObject())
      {
        if (!first) out << ',';
        out << '"' << occweb::JsonEscape(key) << "\":" << stringify(item);
        first = false;
      }
      out << '}';
      return out.str();
    }
  }
  return "null";
}

bool validKey(const std::string& key)
{
  if (key.empty() || key.size() > 128) return false;
  for (const unsigned char character : key)
    if (character < 0x20 || character == 0x7f) return false;
  return true;
}

void validateValue(const std::string& type, const occweb::JsonValue& value)
{
  if (type == "int")
  {
    if (!value.IsNumber()) throw occweb::CadError("INVALID_PROPERTY_VALUE", "Integer property requires a number.");
    value.AsInteger();
    return;
  }
  if (type == "double")
  {
    if (!value.IsNumber() || !std::isfinite(value.AsNumber()))
      throw occweb::CadError("INVALID_PROPERTY_VALUE", "Double property requires a finite number.");
    return;
  }
  if (type == "bool")
  {
    if (!value.IsBoolean()) throw occweb::CadError("INVALID_PROPERTY_VALUE", "Boolean property requires true or false.");
    return;
  }
  if (type == "expression")
  {
    if (!value.IsString() || value.AsString().size() > 4096)
      throw occweb::CadError("INVALID_PROPERTY_VALUE", "Expression property must contain at most 4096 bytes.");
    return;
  }
  throw occweb::CadError("INVALID_PROPERTY_TYPE", "Property type must be int, double, bool or expression.");
}
}

namespace occweb
{
void UserPropertyStore::Clear() { myRecords.clear(); }

std::string UserPropertyStore::recordKey(const std::string& kind, const std::string& bodyId,
                                         const std::string& topologyId)
{
  return kind + '|' + bodyId + '|' + topologyId;
}

void UserPropertyStore::Set(const std::string& kind, const std::string& bodyId,
                            const std::string& topologyId, const std::string& key,
                            const std::string& type, const JsonValue& value)
{
  if (!validKey(key)) throw CadError("INVALID_PROPERTY_KEY", "Property key must be 1-128 printable characters.");
  validateValue(type, value);
  UserPropertyRecord& record = myRecords[recordKey(kind, bodyId, topologyId)];
  record.Kind = kind;
  record.BodyId = bodyId;
  record.TopologyId = topologyId;
  record.State = "active";
  record.StateReason.clear();
  record.Values[key] = {type, stringify(value)};
}

bool UserPropertyStore::Delete(const std::string& kind, const std::string& bodyId,
                               const std::string& topologyId, const std::string& key)
{
  auto record = myRecords.find(recordKey(kind, bodyId, topologyId));
  if (record == myRecords.end()) return false;
  const bool removed = record->second.Values.erase(key) > 0;
  if (record->second.Values.empty()) myRecords.erase(record);
  return removed;
}

void UserPropertyStore::RemoveBody(const std::string& bodyId)
{
  for (auto record = myRecords.begin(); record != myRecords.end();)
  {
    if (record->second.BodyId == bodyId) record = myRecords.erase(record);
    else ++record;
  }
}

void UserPropertyStore::OrphanTopology(const std::string& bodyId, const std::string& reason)
{
  for (auto& [unused, record] : myRecords)
  {
    if (record.BodyId == bodyId && record.Kind != "body" && record.State == "active")
    {
      record.State = "orphaned";
      record.StateReason = reason;
    }
  }
}

void UserPropertyStore::OrphanBody(const std::string& bodyId, const std::string& reason)
{
  for (auto& [unused, record] : myRecords)
  {
    if (record.BodyId == bodyId && record.State == "active")
    {
      record.State = "orphaned";
      record.StateReason = reason;
    }
  }
}

void UserPropertyStore::ReactivateBodyProperties(const std::string& bodyId,
                                                 const std::string& reason)
{
  for (auto& [unused, record] : myRecords)
  {
    if (record.BodyId == bodyId && record.Kind == "body" && record.State == "orphaned")
    {
      record.State = "active";
      record.StateReason = reason;
    }
  }
}
void UserPropertyStore::CopyBodyProperties(const std::string& sourceBodyId,
                                          const std::string& destinationBodyId,
                                          const std::string& reason)
{
  for (const auto& [unused, source] : myRecords)
  {
    if (source.BodyId != sourceBodyId || source.Kind != "body" || source.State != "active") continue;
    UserPropertyRecord& destination = myRecords[recordKey("body", destinationBodyId, "")];
    if (destination.Kind.empty())
    {
      destination.Kind = "body";
      destination.BodyId = destinationBodyId;
      destination.State = "active";
      destination.StateReason = reason;
    }
    for (const auto& [propertyKey, propertyValue] : source.Values)
      if (destination.Values.find(propertyKey) == destination.Values.end())
        destination.Values[propertyKey] = propertyValue;
      else if (destination.Values.at(propertyKey).Type != propertyValue.Type
               || destination.Values.at(propertyKey).ValueJson != propertyValue.ValueJson)
      {
        destination.State = "conflict";
        destination.StateReason = reason + ": different Body values merged for key " + propertyKey;
      }
  }
}

void UserPropertyStore::CopyTopologyProperties(
    const std::string& sourceBodyId, const std::string& destinationBodyId,
    const std::map<std::string, std::vector<std::string>>& remap,
    const std::string& reason)
{
  for (const auto& [unused, source] : myRecords)
  {
    if (source.BodyId != sourceBodyId || source.Kind == "body" || source.State != "active") continue;
    const auto mapping = remap.find(source.TopologyId);
    if (mapping == remap.end()) continue;
    for (const std::string& destinationId : mapping->second)
    {
      UserPropertyRecord& destination =
        myRecords[recordKey(source.Kind, destinationBodyId, destinationId)];
      if (destination.Kind.empty())
      {
        destination.Kind = source.Kind;
        destination.BodyId = destinationBodyId;
        destination.TopologyId = destinationId;
        destination.State = "active";
        destination.StateReason = reason;
      }
      for (const auto& [propertyKey, propertyValue] : source.Values)
      {
        const auto existing = destination.Values.find(propertyKey);
        if (existing == destination.Values.end())
          destination.Values[propertyKey] = propertyValue;
        else if (existing->second.Type != propertyValue.Type
                 || existing->second.ValueJson != propertyValue.ValueJson)
        {
          destination.State = "conflict";
          destination.StateReason = reason + ": different values copied";
        }
      }
    }
  }
}

void UserPropertyStore::RemapTopology(
    const std::string& sourceBodyId, const std::string& destinationBodyId,
    const std::map<std::string, std::vector<std::string>>& remap, const std::string& reason,
    const bool restoreOrphaned)
{
  std::vector<std::string> sourceKeys;
  for (const auto& [key, record] : myRecords)
    if (record.BodyId == sourceBodyId && record.Kind != "body"
        && (record.State == "active" || (restoreOrphaned && record.State == "orphaned" && remap.find(record.TopologyId)!=remap.end())))
      sourceKeys.push_back(key);

  for (const std::string& sourceKey : sourceKeys)
  {
    UserPropertyRecord& source = myRecords.at(sourceKey);
    const auto mapping = remap.find(source.TopologyId);
    if (mapping == remap.end() || mapping->second.empty())
    {
      source.State = "orphaned";
      source.StateReason = reason + ": source topology was deleted";
      continue;
    }

    const UserPropertyRecord sourceCopy = source;
    source.State = "superseded";
    source.StateReason = reason + ": properties propagated to current topology";
    for (const std::string& destinationId : mapping->second)
    {
      UserPropertyRecord& destination =
        myRecords[recordKey(source.Kind, destinationBodyId, destinationId)];
      if (destination.Kind.empty())
      {
        destination.Kind = source.Kind;
        destination.BodyId = destinationBodyId;
        destination.TopologyId = destinationId;
        destination.State = "active";
        destination.StateReason = "propagated from " + source.TopologyId;
      }
      else if(restoreOrphaned && destination.State=="orphaned")
      {
        destination.State="active";
        destination.StateReason=reason+": verified restored topology";
      }
      for (const auto& [propertyKey, propertyValue] : sourceCopy.Values)
      {
        const auto existing = destination.Values.find(propertyKey);
        if (existing == destination.Values.end())
        {
          destination.Values[propertyKey] = propertyValue;
        }
        else if (existing->second.Type != propertyValue.Type
                 || existing->second.ValueJson != propertyValue.ValueJson)
        {
          destination.State = "conflict";
          destination.StateReason = "different values propagated to the same topology for key "
                                  + propertyKey;
        }
      }
    }
  }
}

void UserPropertyStore::RemapTopologyToBodies(
    const std::string& sourceBodyId,
    const std::map<std::string, std::map<std::string, std::vector<std::string>>>& destinations,
    const bool keepSource, const std::string& reason)
{
  // Snapshot sources before inserting results. Several output Bodies may share
  // the same topology ID/revision, but their ownership is not interchangeable.
  std::vector<std::pair<std::string, UserPropertyRecord>> sources;
  for (const auto& [key, record] : myRecords)
    if (record.BodyId == sourceBodyId && record.Kind != "body"
        && (record.State == "active" || record.State == "conflict"))
    {
      bool isSource=false;
      for(const auto& [unused,mapping]:destinations)if(mapping.find(record.TopologyId)!=mapping.end()){isSource=true;break;}
      if(isSource)sources.emplace_back(key, record);
    }
  for (const auto& [sourceKey, source] : sources)
  {
    bool mapped = false;
    for (const auto& [destinationBodyId, remap] : destinations)
    {
      const auto found = remap.find(source.TopologyId);
      if (found == remap.end()) continue;
      for (const std::string& destinationId : found->second)
      {
        mapped = true;
        UserPropertyRecord& destination = myRecords[recordKey(source.Kind, destinationBodyId, destinationId)];
        if (destination.Kind.empty())
        {
          destination.Kind = source.Kind;
          destination.BodyId = destinationBodyId;
          destination.TopologyId = destinationId;
          destination.State = source.State;
          destination.StateReason = reason + ": OCCT history from " + sourceBodyId + "/" + source.TopologyId;
        }
        if (source.State == "conflict") destination.State = "conflict";
        for (const auto& [key, value] : source.Values)
        {
          const auto existing = destination.Values.find(key);
          if (existing == destination.Values.end()) destination.Values[key] = value;
          else if (existing->second.Type != value.Type || existing->second.ValueJson != value.ValueJson)
          {
            destination.State = "conflict";
            destination.StateReason = reason + ": different values merged for key " + key;
          }
        }
      }
    }
    if (!keepSource)
    {
      UserPropertyRecord& original = myRecords.at(sourceKey);
      original.State = mapped ? "superseded" : "orphaned";
      original.StateReason = reason + (mapped ? ": propagated using OCCT history" : ": no surviving topology in the result");
    }
  }
}

std::string UserPropertyStore::ToJson(const std::string& kind, const std::string& bodyId,
                                      const std::string& topologyId) const
{
  std::ostringstream out;
  out << '[';
  bool firstRecord = true;
  for (const auto& [unused, record] : myRecords)
  {
    if ((!kind.empty() && record.Kind != kind) || (!bodyId.empty() && record.BodyId != bodyId)
        || (!topologyId.empty() && record.TopologyId != topologyId)) continue;
    if (!firstRecord) out << ',';
    out << "{\"kind\":\"" << JsonEscape(record.Kind)
        << "\",\"bodyId\":\"" << JsonEscape(record.BodyId)
        << "\",\"topologyId\":\"" << JsonEscape(record.TopologyId)
        << "\",\"state\":\"" << JsonEscape(record.State)
        << "\",\"stateReason\":\"" << JsonEscape(record.StateReason) << "\",\"values\":{";
    bool firstValue = true;
    for (const auto& [key, value] : record.Values)
    {
      if (!firstValue) out << ',';
      out << '"' << JsonEscape(key) << "\":{\"type\":\"" << JsonEscape(value.Type)
          << "\",\"value\":" << value.ValueJson << '}';
      firstValue = false;
    }
    out << "}}";
    firstRecord = false;
  }
  out << ']';
  return out.str();
}

void UserPropertyStore::FromJson(const JsonValue& value)
{
  myRecords.clear();
  for (const JsonValue& item : value.AsArray())
  {
    UserPropertyRecord record;
    record.Kind = item.GetString("kind");
    record.BodyId = item.GetString("bodyId");
    record.TopologyId = item.GetStringOr("topologyId", "");
    record.State = item.GetStringOr("state", "active");
    record.StateReason = item.GetStringOr("stateReason", "");
    for (const auto& [key, entry] : item.At("values").AsObject())
      record.Values[key] = {entry.GetString("type"), stringify(entry.At("value"))};
    myRecords[recordKey(record.Kind, record.BodyId, record.TopologyId)] = std::move(record);
  }
}
}
