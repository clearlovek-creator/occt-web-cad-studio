// SPDX-License-Identifier: GPL-3.0-or-later
#include "QualityControl.hxx"
#include "LocalCoordinateFrame.hxx"
#include <algorithm>
#include <cmath>
#include <iostream>
#include <stdexcept>

namespace {
using namespace occweb::discrete;
using J = occweb::JsonValue;
void expect(bool value, const char* message) {if (!value) throw std::runtime_error(message);}
void near(double value, double expected) {expect(std::abs(value-expected)<2e-12,"Analytic SICN mismatch");}
template<class F> void rejects(F action) {bool failed=false;try{action();}catch(const std::exception&){failed=true;}expect(failed,"Invalid controls accepted");}
J parse(const std::string& text) {return occweb::JsonParser(text).Parse();}
}

int main() {
  try {
    const Point a={0,0,0}, b={1,0,0}, c={.5,std::sqrt(3.)/2,0}, d={.5,std::sqrt(3.)/6,std::sqrt(2./3)};
    near(signedInverseCondition(a,b,c,d),1);
    near(signedInverseCondition(a,c,b,d),-1);
    near(signedInverseCondition(d,a,c,b),1);
    for (const double scale : {1e-140,1e-8,1.,1e8,1e140}) {
      auto scaled=[&](Point p){for(auto& x:p)x*=scale;return p;};
      near(signedInverseCondition(scaled(a),scaled(b),scaled(c),scaled(d)),1);
    }
    Point flat=d;flat[2]=0;near(signedInverseCondition(a,b,c,flat),0);
    rejects([&]{signedInverseCondition(a,a,a,a);});
    const LocalCoordinateFrame frame({1e6,-1e6,1e6});
    const Point world={1e6+.6,-1e6+1.25,1e6+2};
    expect(frame.world(frame.local(world))==world,"Local frame changed source coordinates");
    const auto rounded=frame.canonical({.123456789,.234567891,.345678912});
    expect(frame.canonical(rounded)==rounded,"Coordinate publication is not idempotent");
    const LocalCoordinateFrame excessive({1e12,-1e12,1e12});
    rejects([&]{excessive.canonical({.123456789,.234567891,.345678912});});
    const auto defaults=parseControls(parse("{}"));expect(defaults.method.empty()&&!defaults.strict&&defaults.threshold==.2,"Unexpected defaults");
    for(const auto* method:{"gmsh","netgen","relocate"}){
      const auto controls=parseControls(parse(std::string("{\"optimization\":{\"version\":1,\"method\":\"")+method+"\",\"iterations\":3}}"));
      expect(controls.method==method&&controls.iterations==3,"Explicit optimization lost");
    }
    const auto strict=parseControls(parse("{\"quality\":{\"version\":1,\"mode\":\"strict\",\"threshold\":0.3,\"maxBadFraction\":0.05}}"));
    expect(strict.strict&&strict.threshold==.3&&strict.maxBadFraction==.05,"Explicit policy lost");
    for(const auto* bad:{"{\"optimization\":null}","{\"optimization\":{\"version\":2,\"method\":\"gmsh\",\"iterations\":1}}","{\"optimization\":{\"version\":1,\"method\":\"arbitrary\",\"iterations\":1}}","{\"optimization\":{\"version\":1,\"method\":\"netgen\",\"iterations\":0}}","{\"optimization\":{\"version\":1,\"method\":\"netgen\",\"iterations\":6}}","{\"optimization\":{\"version\":1,\"method\":\"netgen\",\"iterations\":1,\"path\":\"x\"}}","{\"quality\":{\"version\":1,\"mode\":\"silent\",\"threshold\":0.2,\"maxBadFraction\":0}}","{\"quality\":{\"version\":1,\"mode\":\"strict\",\"threshold\":-0.1,\"maxBadFraction\":0}}","{\"quality\":{\"version\":1,\"mode\":\"strict\",\"threshold\":0.2,\"maxBadFraction\":1.1}}"})
      rejects([&]{parseControls(parse(bad));});
    BoundarySnapshot original;original.triangles[1]={{1,2,3}};original.nodes={{1,a},{2,b},{3,c}};
    auto broken=original;expect(broken==original,"Equal boundary snapshot differs");
    broken.nodes[1][0]=1e-15;expect(!(broken==original),"Boundary displacement missed");
    broken=original;std::swap(broken.triangles[1][0][1],broken.triangles[1][0][2]);expect(!(broken==original),"Boundary reflection missed");
    broken=original;broken.triangles[1][0][0]=4;broken.nodes[4]=a;expect(!(broken==original),"Coordinate-equal node replacement missed");
    QualitySnapshot snapshot;snapshot.cells={{100,1,.1},{1,1,.1}};snapshot.all={101,2,.1};
    Controls policy;policy.maxBadFraction=.05;
    const auto report=qualityJson(snapshot,policy);
    expect(report.At("lowQualityFraction").AsNumber()<.05&&!report.At("meetsRequestedQuality").AsBoolean(),"Global averages hide a failing connected cell");
    QualitySnapshot before,after;before.cells={{100,0,.7},{1,1,.1}};before.all={101,1,.1};after.cells={{1,0,.7},{100,100,.1}};after.all={101,100,.1};
    const auto regression=compareQuality(before,after);
    expect(regression.global&&regression.cells.empty(),"Changed cell weights hide global regression");
    std::cout<<"Coordinate SICN, scale, orientation, controls, per-cell gate and boundary protection passed\n";
    return 0;
  } catch(const std::exception& e) {std::cerr<<e.what()<<'\n';return 1;}
}
