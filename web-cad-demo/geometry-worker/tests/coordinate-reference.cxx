#include "../src/document/ParameterStore.hxx"
#include "../src/document/CadError.hxx"
#include <iostream>
#include <stdexcept>

using namespace occweb;
int main()
{
  try
  {
    CoordinateSystemStore store;
    store.FromJson(JsonParser(R"([{"id":"legacy","name":"Old face frame","kind":"face","origin":[10,20,30],"xAxis":[2,0,0],"yAxis":[1,2,0],"referenceBodyId":"body-1","referenceTopologyId":"face-12-4"}])").Parse());
    const auto& legacy=store.Get("legacy");
    if (legacy.AssociationMode!="snapshot" || legacy.ReferenceState!="snapshot" || !legacy.ReferenceSelector.empty()
        || legacy.Origin!=std::array<double,3>{10,20,30} || legacy.XAxis!=std::array<double,3>{2,0,0}
        || legacy.YAxis!=std::array<double,3>{1,2,0})
      throw std::runtime_error("Legacy face coordinates must remain exact snapshots, never auto-bind by an old face number.");
    CoordinateSystemStore restored;restored.FromJson(JsonParser(store.ToJson(true)).Parse());
    if (restored.Get("legacy").Origin!=legacy.Origin || restored.Get("legacy").YAxis!=legacy.YAxis)
      throw std::runtime_error("Snapshot round-trip changed legacy placement axes.");
    auto invalid=legacy;invalid.Id="invalid";invalid.AssociationMode="associative";invalid.ReferenceState="resolved";
    bool rejected=false;try{store.Set(invalid);}catch(const CadError& error){rejected=error.Code()=="INVALID_COORDINATE_REFERENCE";}
    if (!rejected) throw std::runtime_error("Incomplete persistent references must be rejected.");
    invalid.ReferenceBodyIdentity=std::string(32,'a');invalid.ReferenceFeatureIdentity=std::string(32,'b');invalid.ReferenceFeatureId="feature-1";invalid.ReferenceSelector=R"({"kind":"edge"})";
    rejected=false;try{store.Set(invalid);}catch(const CadError& error){rejected=error.Code()=="INVALID_COORDINATE_REFERENCE";}
    if (!rejected) throw std::runtime_error("An Edge selector cannot masquerade as a Face coordinate.");
    std::cout<<"PASS legacy coordinate snapshots retain their exact placement and never fabricate a persistent anchor\n";
    return 0;
  }
  catch(const std::exception& error){std::cerr<<error.what()<<'\n';return 1;}
}
