#include "Json.hxx"

#include <cctype>
#include <cerrno>
#include <cmath>
#include <cstdlib>
#include <iomanip>
#include <limits>
#include <sstream>

namespace occweb
{
std::string JsonSerialize(const JsonValue& value)
{
  std::ostringstream out;
  out << std::setprecision(std::numeric_limits<double>::max_digits10);
  if (value.IsNull()) out << "null";
  else if (value.IsBoolean()) out << (value.AsBoolean() ? "true" : "false");
  else if (value.IsNumber())
  {
    if (!std::isfinite(value.AsNumber())) throw JsonError("Cannot serialize a non-finite JSON number.");
    out << value.AsNumber();
  }
  else if (value.IsString()) out << '"' << JsonEscape(value.AsString()) << '"';
  else if (value.IsArray())
  {
    out << '[';
    bool first = true;
    for (const auto& item : value.AsArray())
    {
      if (!first) out << ',';
      first = false;
      out << JsonSerialize(item);
    }
    out << ']';
  }
  else
  {
    out << '{';
    bool first = true;
    for (const auto& [key, item] : value.AsObject())
    {
      if (!first) out << ',';
      first = false;
      out << '"' << JsonEscape(key) << "\":" << JsonSerialize(item);
    }
    out << '}';
  }
  return out.str();
}
namespace
{
const char* typeName(const JsonValue::Type type)
{
  switch (type)
  {
    case JsonValue::Type::Null: return "null";
    case JsonValue::Type::Boolean: return "boolean";
    case JsonValue::Type::Number: return "number";
    case JsonValue::Type::String: return "string";
    case JsonValue::Type::Array: return "array";
    case JsonValue::Type::Object: return "object";
  }
  return "unknown";
}

void requireType(const JsonValue::Type actual, const JsonValue::Type expected)
{
  if (actual != expected)
  {
    throw JsonError(std::string("Expected JSON ") + typeName(expected) + ", got " + typeName(actual) + '.');
  }
}
}

JsonValue::JsonValue(const bool value)
    : myType(Type::Boolean), myBoolean(value)
{
}

JsonValue::JsonValue(const double value)
    : myType(Type::Number), myNumber(value)
{
}

JsonValue::JsonValue(std::string value)
    : myType(Type::String), myString(std::move(value))
{
}

JsonValue JsonValue::MakeArray()
{
  JsonValue value;
  value.myType = Type::Array;
  return value;
}

JsonValue JsonValue::MakeObject()
{
  JsonValue value;
  value.myType = Type::Object;
  return value;
}

bool JsonValue::AsBoolean() const
{
  requireType(myType, Type::Boolean);
  return myBoolean;
}

double JsonValue::AsNumber() const
{
  requireType(myType, Type::Number);
  return myNumber;
}

int JsonValue::AsInteger() const
{
  const double value = AsNumber();
  if (!std::isfinite(value) || std::floor(value) != value
      || value < static_cast<double>(std::numeric_limits<int>::min())
      || value > static_cast<double>(std::numeric_limits<int>::max()))
  {
    throw JsonError("Expected a JSON integer in the supported range.");
  }
  return static_cast<int>(value);
}

const std::string& JsonValue::AsString() const
{
  requireType(myType, Type::String);
  return myString;
}

const std::vector<JsonValue>& JsonValue::AsArray() const
{
  requireType(myType, Type::Array);
  return myArray;
}

const std::map<std::string, JsonValue>& JsonValue::AsObject() const
{
  requireType(myType, Type::Object);
  return myObject;
}

std::vector<JsonValue>& JsonValue::ChangeArray()
{
  requireType(myType, Type::Array);
  return myArray;
}

std::map<std::string, JsonValue>& JsonValue::ChangeObject()
{
  requireType(myType, Type::Object);
  return myObject;
}

bool JsonValue::Has(const std::string& key) const
{
  return Find(key) != nullptr;
}

const JsonValue& JsonValue::At(const std::string& key) const
{
  const JsonValue* value = Find(key);
  if (value == nullptr)
  {
    throw JsonError("Missing required JSON field: " + key + '.');
  }
  return *value;
}

const JsonValue* JsonValue::Find(const std::string& key) const
{
  requireType(myType, Type::Object);
  const auto iterator = myObject.find(key);
  return iterator == myObject.end() ? nullptr : &iterator->second;
}

std::string JsonValue::GetString(const std::string& key) const
{
  return At(key).AsString();
}

std::string JsonValue::GetStringOr(const std::string& key, const std::string& fallback) const
{
  const JsonValue* value = Find(key);
  return value == nullptr || value->IsNull() ? fallback : value->AsString();
}

double JsonValue::GetNumber(const std::string& key) const
{
  return At(key).AsNumber();
}

double JsonValue::GetNumberOr(const std::string& key, const double fallback) const
{
  const JsonValue* value = Find(key);
  return value == nullptr || value->IsNull() ? fallback : value->AsNumber();
}

int JsonValue::GetInteger(const std::string& key) const
{
  return At(key).AsInteger();
}

int JsonValue::GetIntegerOr(const std::string& key, const int fallback) const
{
  const JsonValue* value = Find(key);
  return value == nullptr || value->IsNull() ? fallback : value->AsInteger();
}

bool JsonValue::GetBooleanOr(const std::string& key, const bool fallback) const
{
  const JsonValue* value = Find(key);
  return value == nullptr || value->IsNull() ? fallback : value->AsBoolean();
}

JsonValue JsonParser::Parse()
{
  skipWhitespace();
  JsonValue result = parseValue();
  skipWhitespace();
  if (myPosition != myText.size())
  {
    fail("Unexpected trailing characters");
  }
  return result;
}

JsonValue JsonParser::parseValue()
{
  skipWhitespace();
  if (myPosition >= myText.size())
  {
    fail("Unexpected end of input");
  }

  const char character = myText[myPosition];
  if (character == '{') return parseObject();
  if (character == '[') return parseArray();
  if (character == '"') return JsonValue(parseString());
  if (character == '-' || std::isdigit(static_cast<unsigned char>(character))) return parseNumber();
  if (startsWith("true"))
  {
    myPosition += 4;
    return JsonValue(true);
  }
  if (startsWith("false"))
  {
    myPosition += 5;
    return JsonValue(false);
  }
  if (startsWith("null"))
  {
    myPosition += 4;
    return JsonValue();
  }
  fail("Unexpected token");
}

JsonValue JsonParser::parseObject()
{
  expect('{');
  JsonValue object = JsonValue::MakeObject();
  skipWhitespace();
  if (consume('}')) return object;

  while (true)
  {
    skipWhitespace();
    if (myPosition >= myText.size() || myText[myPosition] != '"')
    {
      fail("Expected an object key");
    }
    const std::string key = parseString();
    skipWhitespace();
    expect(':');
    JsonValue value = parseValue();
    auto [iterator, inserted] = object.ChangeObject().emplace(key, std::move(value));
    if (!inserted)
    {
      fail("Duplicate object key: " + key);
    }
    skipWhitespace();
    if (consume('}')) return object;
    expect(',');
  }
}

JsonValue JsonParser::parseArray()
{
  expect('[');
  JsonValue array = JsonValue::MakeArray();
  skipWhitespace();
  if (consume(']')) return array;

  while (true)
  {
    array.ChangeArray().push_back(parseValue());
    skipWhitespace();
    if (consume(']')) return array;
    expect(',');
  }
}

JsonValue JsonParser::parseNumber()
{
  const char* begin = myText.c_str() + myPosition;
  char* end = nullptr;
  errno = 0;
  const double value = std::strtod(begin, &end);
  if (begin == end || errno == ERANGE || !std::isfinite(value))
  {
    fail("Invalid number");
  }
  myPosition += static_cast<std::size_t>(end - begin);
  return JsonValue(value);
}

std::string JsonParser::parseString()
{
  expect('"');
  std::string result;
  while (myPosition < myText.size())
  {
    const char character = myText[myPosition++];
    if (character == '"') return result;
    if (static_cast<unsigned char>(character) < 0x20)
    {
      fail("Unescaped control character in string");
    }
    if (character != '\\')
    {
      result.push_back(character);
      continue;
    }
    if (myPosition >= myText.size()) fail("Incomplete string escape");
    const char escaped = myText[myPosition++];
    switch (escaped)
    {
      case '"': result.push_back('"'); break;
      case '\\': result.push_back('\\'); break;
      case '/': result.push_back('/'); break;
      case 'b': result.push_back('\b'); break;
      case 'f': result.push_back('\f'); break;
      case 'n': result.push_back('\n'); break;
      case 'r': result.push_back('\r'); break;
      case 't': result.push_back('\t'); break;
      case 'u': appendUtf8(result, parseHexCodePoint()); break;
      default: fail("Unsupported string escape");
    }
  }
  fail("Unterminated string");
}

std::uint32_t JsonParser::parseHexCodePoint()
{
  if (myPosition + 4 > myText.size()) fail("Incomplete Unicode escape");
  std::uint32_t codePoint = 0;
  for (int index = 0; index < 4; ++index)
  {
    const char character = myText[myPosition++];
    codePoint <<= 4;
    if (character >= '0' && character <= '9') codePoint += character - '0';
    else if (character >= 'a' && character <= 'f') codePoint += character - 'a' + 10;
    else if (character >= 'A' && character <= 'F') codePoint += character - 'A' + 10;
    else fail("Invalid Unicode escape");
  }
  return codePoint;
}

void JsonParser::appendUtf8(std::string& target, const std::uint32_t codePoint)
{
  if (codePoint <= 0x7F)
  {
    target.push_back(static_cast<char>(codePoint));
  }
  else if (codePoint <= 0x7FF)
  {
    target.push_back(static_cast<char>(0xC0 | (codePoint >> 6)));
    target.push_back(static_cast<char>(0x80 | (codePoint & 0x3F)));
  }
  else
  {
    target.push_back(static_cast<char>(0xE0 | (codePoint >> 12)));
    target.push_back(static_cast<char>(0x80 | ((codePoint >> 6) & 0x3F)));
    target.push_back(static_cast<char>(0x80 | (codePoint & 0x3F)));
  }
}

void JsonParser::expect(const char character)
{
  skipWhitespace();
  if (myPosition >= myText.size() || myText[myPosition] != character)
  {
    fail(std::string("Expected '") + character + "'");
  }
  ++myPosition;
}

bool JsonParser::consume(const char character)
{
  skipWhitespace();
  if (myPosition < myText.size() && myText[myPosition] == character)
  {
    ++myPosition;
    return true;
  }
  return false;
}

void JsonParser::skipWhitespace()
{
  while (myPosition < myText.size()
         && std::isspace(static_cast<unsigned char>(myText[myPosition])))
  {
    ++myPosition;
  }
}

bool JsonParser::startsWith(const char* token) const
{
  return myText.compare(myPosition, std::char_traits<char>::length(token), token) == 0;
}

void JsonParser::fail(const std::string& message) const
{
  throw JsonError(message + " at byte " + std::to_string(myPosition) + '.');
}

std::string JsonEscape(const std::string& value)
{
  std::ostringstream output;
  for (const unsigned char character : value)
  {
    switch (character)
    {
      case '\\': output << "\\\\"; break;
      case '"': output << "\\\""; break;
      case '\b': output << "\\b"; break;
      case '\f': output << "\\f"; break;
      case '\n': output << "\\n"; break;
      case '\r': output << "\\r"; break;
      case '\t': output << "\\t"; break;
      default:
        if (character < 0x20)
        {
          output << "\\u" << std::hex << std::setw(4) << std::setfill('0')
                 << static_cast<int>(character) << std::dec;
        }
        else
        {
          output << static_cast<char>(character);
        }
        break;
    }
  }
  return output.str();
}
}
