#include "../src/mesh/MeshPreparation.hxx"
#include "../src/protocol/Json.hxx"
#include <BRepPrimAPI_MakeBox.hxx>
#include <BRep_Builder.hxx>
#include <TopoDS_Compound.hxx>
#include <TopExp.hxx>
#include <TopTools_IndexedMapOfShape.hxx>
#include <gp_Pnt.hxx>
#include <iostream>
#include <stdexcept>
#include <cmath>

int main() {
  try {
    TopoDS_Compound compound;BRep_Builder builder;builder.MakeCompound(compound);
    builder.Add(compound,BRepPrimAPI_MakeBox(gp_Pnt(0,0,0),20,10,10).Shape());
    builder.Add(compound,BRepPrimAPI_MakeBox(gp_Pnt(10,0,0),20,10,10).Shape());
    occweb::MeshPreparationBody body{"body-1","Imported compound","solid",std::string(32,'a'),std::string(32,'b'),1,compound,{}};
    TopTools_IndexedMapOfShape faces;TopExp::MapShapes(compound,TopAbs_FACE,faces);
    for(int i=1;i<=faces.Extent();++i)body.FaceIds.push_back("face-1-"+std::to_string(i));
    for(const auto& mode:{"strict","conservative","aggressive"}) {
      const auto output=occweb::PrepareConformalMesh({body},"test",1,mode);const auto manifest=occweb::JsonParser(output.Manifest).Parse();
      if(manifest.At("solids").AsArray().size()!=3)throw std::runtime_error("A single multi-Solid Body was not jointly partitioned.");
      bool shared=false;double mass=0;
      for(const auto& solid:manifest.At("solids").AsArray()) {
        mass+=solid.GetNumber("volume");if(solid.At("sources").AsArray().size()==2)shared=true;
        for(const auto& source:solid.At("sources").AsArray())if(source.GetString("bodyId")!="body-1")throw std::runtime_error("Invalid compound ownership.");
      }
      if(!shared||std::abs(mass-3000)>1e-6||!manifest.At("preprocessing").GetBooleanOr("faceMappingComplete",false))throw std::runtime_error("Compound volume/face history is incomplete.");
    }
    std::cout<<"single Body multi-Solid partition retains shared source history in all repair profiles\n";return 0;
  }catch(const std::exception& error){std::cerr<<error.what()<<'\n';return 1;}
}
