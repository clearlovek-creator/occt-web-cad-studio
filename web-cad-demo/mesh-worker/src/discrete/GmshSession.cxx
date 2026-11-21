// SPDX-License-Identifier: GPL-3.0-or-later
#include "GmshSession.hxx"
#include "QualityControl.hxx"
#include <gmsh.h>
namespace occweb::discrete {
GmshSession::GmshSession() {
  if(gmsh::isInitialized())throw QualityError("MESH_INITIALIZATION_INVALID","A fresh single-job Gmsh session is required.");
  gmsh::initialize(0,nullptr,false,false);
  try {
    gmsh::option::setNumber("General.Terminal",0);
    gmsh::option::setNumber("General.Verbosity",0);
    gmsh::option::getString("General.Version",version);
    if(version!="4.15.2"||std::string(GMSH_API_VERSION)!="4.15.2")throw QualityError("MESH_GMSH_VERSION_UNSUPPORTED","Runtime and API must both be pinned to Gmsh 4.15.2.");
  }catch(...){try{gmsh::finalize();}catch(...){}throw;}
}
GmshSession::~GmshSession() noexcept {try{gmsh::finalize();}catch(...){}}
}
