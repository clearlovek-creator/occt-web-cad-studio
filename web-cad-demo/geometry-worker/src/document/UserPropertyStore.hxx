#pragma once

#include "../protocol/Json.hxx"

#include <map>
#include <string>
#include <vector>

namespace occweb
{
struct UserPropertyValue
{
  std::string Type;
  std::string ValueJson;
};

struct UserPropertyRecord
{
  std::string Kind;
  std::string BodyId;
  std::string TopologyId;
  std::string State = "active";
  std::string StateReason;
  std::map<std::string, UserPropertyValue> Values;
};

class UserPropertyStore
{
public:
  void Clear();
  void Set(const std::string& kind, const std::string& bodyId, const std::string& topologyId,
           const std::string& key, const std::string& type, const JsonValue& value);
  bool Delete(const std::string& kind, const std::string& bodyId, const std::string& topologyId,
              const std::string& key);
  void RemoveBody(const std::string& bodyId);
  void OrphanTopology(const std::string& bodyId, const std::string& reason);
  void OrphanBody(const std::string& bodyId, const std::string& reason);
  void ReactivateBodyProperties(const std::string& bodyId, const std::string& reason);
  void CopyBodyProperties(const std::string& sourceBodyId, const std::string& destinationBodyId, const std::string& reason);
  void CopyTopologyProperties(const std::string& sourceBodyId, const std::string& destinationBodyId,
                     const std::map<std::string, std::vector<std::string>>& remap,
                     const std::string& reason);
  void RemapTopology(const std::string& sourceBodyId, const std::string& destinationBodyId,
                     const std::map<std::string, std::vector<std::string>>& remap,
                     const std::string& reason, bool restoreOrphaned = false);
  void RemapTopologyToBodies(const std::string& sourceBodyId,
                     const std::map<std::string, std::map<std::string, std::vector<std::string>>>& destinations,
                     bool keepSource, const std::string& reason);
  std::string ToJson(const std::string& kind = "", const std::string& bodyId = "",
                     const std::string& topologyId = "") const;
  void FromJson(const JsonValue& value);

private:
  static std::string recordKey(const std::string& kind, const std::string& bodyId,
                               const std::string& topologyId);
  std::map<std::string, UserPropertyRecord> myRecords;
};
}
