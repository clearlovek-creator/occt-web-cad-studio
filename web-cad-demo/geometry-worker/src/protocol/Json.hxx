#pragma once

#include <cstdint>
#include <map>
#include <stdexcept>
#include <string>
#include <vector>

namespace occweb
{
class JsonError : public std::runtime_error
{
public:
  explicit JsonError(const std::string& message)
      : std::runtime_error(message)
  {
  }
};

class JsonValue
{
public:
  enum class Type
  {
    Null,
    Boolean,
    Number,
    String,
    Array,
    Object
  };

  JsonValue() = default;
  explicit JsonValue(bool value);
  explicit JsonValue(double value);
  explicit JsonValue(std::string value);

  static JsonValue MakeArray();
  static JsonValue MakeObject();

  Type GetType() const { return myType; }
  bool IsNull() const { return myType == Type::Null; }
  bool IsBoolean() const { return myType == Type::Boolean; }
  bool IsNumber() const { return myType == Type::Number; }
  bool IsString() const { return myType == Type::String; }
  bool IsArray() const { return myType == Type::Array; }
  bool IsObject() const { return myType == Type::Object; }

  bool AsBoolean() const;
  double AsNumber() const;
  int AsInteger() const;
  const std::string& AsString() const;
  const std::vector<JsonValue>& AsArray() const;
  const std::map<std::string, JsonValue>& AsObject() const;
  std::vector<JsonValue>& ChangeArray();
  std::map<std::string, JsonValue>& ChangeObject();

  bool Has(const std::string& key) const;
  const JsonValue& At(const std::string& key) const;
  const JsonValue* Find(const std::string& key) const;

  std::string GetString(const std::string& key) const;
  std::string GetStringOr(const std::string& key, const std::string& fallback) const;
  double GetNumber(const std::string& key) const;
  double GetNumberOr(const std::string& key, double fallback) const;
  int GetInteger(const std::string& key) const;
  int GetIntegerOr(const std::string& key, int fallback) const;
  bool GetBooleanOr(const std::string& key, bool fallback) const;

private:
  Type myType = Type::Null;
  bool myBoolean = false;
  double myNumber = 0.0;
  std::string myString;
  std::vector<JsonValue> myArray;
  std::map<std::string, JsonValue> myObject;
};

class JsonParser
{
public:
  explicit JsonParser(const std::string& text)
      : myText(text)
  {
  }

  JsonValue Parse();

private:
  JsonValue parseValue();
  JsonValue parseObject();
  JsonValue parseArray();
  JsonValue parseNumber();
  std::string parseString();
  std::uint32_t parseHexCodePoint();
  void appendUtf8(std::string& target, std::uint32_t codePoint);
  void expect(char character);
  bool consume(char character);
  void skipWhitespace();
  bool startsWith(const char* token) const;
  [[noreturn]] void fail(const std::string& message) const;

private:
  const std::string& myText;
  std::size_t myPosition = 0;
};

std::string JsonEscape(const std::string& value);
std::string JsonSerialize(const JsonValue& value);
}
