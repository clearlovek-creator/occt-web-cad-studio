#pragma once

#include <stdexcept>
#include <string>

namespace occweb
{
class CadError : public std::runtime_error
{
public:
  CadError(std::string code, const std::string& message, std::string details = {})
      : std::runtime_error(message), myCode(std::move(code)), myDetails(std::move(details))
  {
  }

  const std::string& Code() const { return myCode; }
  const std::string& Details() const { return myDetails; }

private:
  std::string myCode;
  std::string myDetails;
};
}
