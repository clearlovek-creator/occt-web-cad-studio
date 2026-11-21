#include "CadDocument.hxx"

#include <iomanip>
#include <random>
#include <sstream>

namespace occweb
{
std::string CadDocument::newIdentity()
{
  static std::random_device random;
  std::ostringstream out;
  out << std::hex << std::setfill('0');
  for (int i = 0; i < 4; ++i)
    out << std::setw(8) << static_cast<unsigned int>(random());
  return out.str();
}

std::string CadDocument::identitiesJson() const
{
  std::ostringstream out;
  out << '{';
  bool first = true;
  for (const auto& [id, identity] : myEntityIdentities)
  {
    if (!first) out << ',';
    first = false;
    out << '"' << JsonEscape(id) << "\":{\"bodyIdentity\":\"" << JsonEscape(identity.Body)
        << "\",\"topologyIdentity\":\"" << JsonEscape(identity.Topology)
        << "\",\"topologyRevision\":" << identity.Revision << '}';
  }
  out << '}';
  return out.str();
}

std::string CadDocument::bodyIdentityJson(const std::string& id) const
{
  const auto found = myEntityIdentities.find(id);
  if (found == myEntityIdentities.end()) return "";
  return ",\"bodyIdentity\":\"" + JsonEscape(found->second.Body)
       + "\",\"topologyIdentity\":\"" + JsonEscape(found->second.Topology) + '"';
}

void CadDocument::synchronizeIdentities()
{
  const auto before = myEntityIdentities;
  for (const auto& [id, body] : myBodies)
  {
    auto& identity = myEntityIdentities[id];
    if (identity.Body.empty()) identity.Body = newIdentity();
    if (identity.Topology.empty() || identity.Revision != body.TopologyRevision)
    {
      identity.Topology = newIdentity();
      identity.Revision = body.TopologyRevision;
    }
  }

  // Qualify new evidence against the operation's actual before/after states.
  // Never rewrite already-qualified historical evidence after a later edit.
  const auto identityAt = [&](const std::string& id, int revision) -> const EntityIdentity*
  {
    const auto previous = before.find(id);
    if (previous != before.end() && previous->second.Revision == revision)
      return &previous->second;
    const auto current = myEntityIdentities.find(id);
    return current != myEntityIdentities.end() && current->second.Revision == revision
         ? &current->second : nullptr;
  };
  for (auto& feature : myFeatures)
  {
    for (auto* entries : {&feature.TopologyLineage, &feature.TopologyEvolutions})
    {
      for (auto& entry : *entries)
      {
        if (entry.SourceBodyIdentity.empty())
          if (const auto* identity = identityAt(entry.SourceBodyId, entry.SourceRevision))
          {
            entry.SourceBodyIdentity = identity->Body;
            entry.SourceTopologyIdentity = identity->Topology;
          }
        for (auto& destination : entry.Destinations)
        {
          if (!destination.BodyIdentity.empty()) continue;
          int revision = -1;
          try
          {
            const auto start = destination.TopologyId.find('-');
            revision = std::stoi(destination.TopologyId.substr(start + 1));
          }
          catch (...) { continue; }
          if (const auto* identity = identityAt(destination.BodyId, revision))
          {
            destination.BodyIdentity = identity->Body;
            destination.TopologyIdentity = identity->Topology;
          }
        }
      }
    }
  }
}
}
