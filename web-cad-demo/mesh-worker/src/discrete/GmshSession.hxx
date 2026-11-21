// SPDX-License-Identifier: GPL-3.0-or-later
#pragma once
#include <string>
namespace occweb::discrete {
class GmshSession {
public:
  GmshSession();
  ~GmshSession() noexcept;
  GmshSession(const GmshSession&)=delete;
  GmshSession& operator=(const GmshSession&)=delete;
  const std::string& Version() const {return version;}
private:
  std::string version;
};
}
