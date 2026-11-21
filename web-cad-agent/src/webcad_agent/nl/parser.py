from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Literal

from ..domain.units import parse_angle, parse_length


Kind = Literal["box", "cylinder", "cone", "sphere", "torus", "tube", "translate", "cut", "fuse", "common",
               "fillet", "chamfer", "pattern_linear", "pattern_circular", "pattern_rectangular", "pattern_mirror",
               "material", "unknown"]


@dataclass(frozen=True)
class ParsedCommand:
    """A small, provider-neutral command representation.

    Parsing only extracts user-provided values.  It never chooses an entity or
    invents a missing CAD parameter; callers must turn ``missing`` into an
    elicitation request.
    """

    kind: Kind
    arguments: dict[str, Any] = field(default_factory=dict)
    reference: str | None = None
    missing: tuple[str, ...] = ()
    reason: str = ""

    @property
    def complete(self) -> bool:
        return not self.missing and self.kind != "unknown"


_NUMBER = r"[+-]?(?:\d+(?:\.\d*)?|\.\d+)"
_UNIT = r"(?:mm|millimeters?|cm|m|in|inch|ft|feet)"
_VALUE = rf"({_NUMBER})\s*({_UNIT})?"
_BOX_WORDS = re.compile(r"(?:box|cuboid|长方体|方盒|矩形体)", re.I)
_TUBE_WORDS = re.compile(r"(?:hollow\s+tube|tube|pipe|空心管|圆管|管道)", re.I)
_CYLINDER_WORDS = re.compile(r"(?:cylinder|圆柱)", re.I)
_CONE_WORDS = re.compile(r"(?:cone|圆锥)", re.I)
_SPHERE_WORDS = re.compile(r"(?:sphere|球体|球)", re.I)
_TORUS_WORDS = re.compile(r"(?:torus|圆环|环体)", re.I)
_BOOLEAN_WORDS = re.compile(r"(?:cut|subtract|boolean\s+cut|相减|切除|扣除|fuse|union|合并|融合|common|intersection|相交)", re.I)


_FILLET_WORDS = re.compile(r"(?:fillet|round\s+edge)", re.I)
_CHAMFER_WORDS = re.compile(r"(?:chamfer|bevel)", re.I)
_PATTERN_WORDS = re.compile(r"(?:pattern|array|linear\s+pattern|circular\s+pattern|rectangular\s+pattern|mirror\s+pattern)", re.I)


def _entity_references(text: str) -> list[str]:
    return re.findall(r"@?(?:body|feature|face|edge)[-_:/\w]+|Body[-_]?\w+|Edge[-_]?\w+", text, re.I)


def _detail(text: str, kind: Literal["fillet", "chamfer"]) -> ParsedCommand:
    refs = _entity_references(text)
    body = next((ref for ref in refs if ref.lower().startswith(("body", "@body"))), None)
    edges = [ref for ref in refs if ref.lower().startswith(("edge", "@edge"))]
    value = _value(text, ("radius", "r", "distance", "size"))
    field = "radius" if kind == "fillet" else "distance"
    missing = tuple(name for name, current in (("bodyId", body), ("edgeIds", edges), (field, value)) if not current)
    return ParsedCommand(kind=kind, arguments={"bodyId": body, "edgeIds": edges, field: value}, missing=missing,
                         reason=f"{kind}_entity_parameters")


def _pattern(text: str, kind: Kind) -> ParsedCommand:
    refs = _entity_references(text)
    body = next((ref for ref in refs if ref.lower().startswith(("body", "@body"))), None)
    args: dict[str, Any] = {"bodyId": body}
    missing: list[str] = ["bodyId"] if body is None else []
    if kind == "pattern_linear":
        count = _value(text, ("count", "quantity")); spacing = _value(text, ("spacing", "pitch", "step"))
        args.update({"count": int(count) if count is not None and float(count).is_integer() else count, "spacing": spacing,
                     "directionX": 1.0, "directionY": 0.0, "directionZ": 0.0})
        missing.extend(name for name, value in (("count", count), ("spacing", spacing)) if value is None)
    elif kind == "pattern_circular":
        count = _value(text, ("count", "quantity")); angle = _angle_value(text, ("angle", "angleDegrees"))
        args.update({"count": int(count) if count is not None and float(count).is_integer() else count, "angleDegrees": angle,
                     "axisX": 0.0, "axisY": 0.0, "axisZ": 1.0})
        missing.extend(name for name, value in (("count", count), ("angleDegrees", angle)) if value is None)
    elif kind == "pattern_rectangular":
        count_x = _value(text, ("countX", "columns")); count_y = _value(text, ("countY", "rows"))
        spacing_x = _value(text, ("spacingX", "pitchX")); spacing_y = _value(text, ("spacingY", "pitchY"))
        args.update({"countX": int(count_x) if count_x is not None and float(count_x).is_integer() else count_x,
                     "countY": int(count_y) if count_y is not None and float(count_y).is_integer() else count_y,
                     "spacingX": spacing_x, "spacingY": spacing_y, "directionX": 1.0, "directionY": 0.0, "directionZ": 0.0,
                     "direction2X": 0.0, "direction2Y": 1.0, "direction2Z": 0.0})
        missing.extend(name for name, value in (("countX", count_x), ("countY", count_y), ("spacingX", spacing_x), ("spacingY", spacing_y)) if value is None)
    else:
        args.update({"normalX": 0.0, "normalY": 0.0, "normalZ": 1.0})
    return ParsedCommand(kind=kind, arguments=args, missing=tuple(dict.fromkeys(missing)), reason="pattern_parameters")


def _material(text: str) -> ParsedCommand:
    match = re.search(r"(?:material)\s*[:=]?\s*([A-Za-z][\w.-]*)", text, re.I)
    name = match.group(1) if match else None
    return ParsedCommand(kind="material", arguments={"name": name}, missing=("name",) if not name else (), reason="material_parameters")


def _value(text: str, labels: tuple[str, ...]) -> float | None:
    label = "|".join(re.escape(item) for item in labels)
    match = re.search(rf"(?<![A-Za-z])(?:{label})(?![A-Za-z])\s*[:=]?\s*{_VALUE}", text, re.I)
    if not match:
        return None
    number, unit = match.group(1), match.group(2) or "mm"
    return parse_length(f"{number}{unit}")


def _angle_value(text: str, labels: tuple[str, ...]) -> float | None:
    label = "|".join(re.escape(item) for item in labels)
    match = re.search(rf"(?<![A-Za-z])(?:{label})(?![A-Za-z])\s*[:=]?\s*({_NUMBER})\s*(deg|degree|degrees|rad)?", text, re.I)
    if not match:
        return None
    return parse_angle(f"{match.group(1)}{match.group(2) or 'deg'}")


def _values_after_word(text: str, word: re.Pattern[str], count: int) -> list[float]:
    match = word.search(text)
    if not match:
        return []
    tail = text[match.end():]
    raw_values = re.findall(_VALUE, tail, re.I)
    # Chinese natural phrasing commonly puts dimensions before the noun:
    # ``100×80×50 的长方体``.  In that case inspect the preceding clause too.
    if not raw_values:
        raw_values = re.findall(_VALUE, text[:match.start()], re.I)
    values = []
    for number, unit in raw_values:
        values.append(parse_length(f"{number}{unit or 'mm'}"))
        if len(values) == count:
            break
    return values


def _origin(text: str) -> dict[str, float]:
    result: dict[str, float] = {}
    for axis in ("x", "y", "z"):
        match = re.search(rf"(?:\b{axis}\b\s*(?:coordinate|坐标)?|{axis}坐标)\s*[:=]\s*{_VALUE}", text, re.I)
        result[axis] = parse_length(f"{match.group(1)}{match.group(2) or 'mm'}") if match else 0.0
    return result


def _primitive(text: str, kind: Kind, word: re.Pattern[str]) -> ParsedCommand:
    origin = _origin(text)
    if kind == "box":
        values = {key: _value(text, labels) for key, labels in {
            "width": ("width", "宽", "长度"),
            "depth": ("depth", "深", "进深"),
            "height": ("height", "高"),
        }.items()}
        missing = tuple(key for key, value in values.items() if value is None)
        if missing:
            values_list = _values_after_word(text, word, 3)
            for key, value in zip(("width", "depth", "height"), values_list):
                if values[key] is None:
                    values[key] = value
            missing = tuple(key for key, value in values.items() if value is None)
        return ParsedCommand(kind=kind, arguments={**origin, **{k: v for k, v in values.items() if v is not None}},
                             missing=missing, reason="box_dimensions")
    if kind == "cylinder":
        radius = _value(text, ("radius", "r", "半径"))
        height = _value(text, ("height", "h", "高", "高度"))
        values = _values_after_word(text, word, 2)
        radius = radius if radius is not None else (values[0] if values else None)
        height = height if height is not None else (values[1] if len(values) > 1 else None)
        missing = tuple(key for key, value in (("radius", radius), ("height", height)) if value is None)
        return ParsedCommand(kind=kind, arguments={"radius": radius, "height": height, **origin},
                             missing=missing, reason="cylinder_parameters")
    if kind == "cone":
        radius1 = _value(text, ("radius1", "r1", "底半径", "下半径"))
        radius2 = _value(text, ("radius2", "r2", "顶半径", "上半径"))
        height = _value(text, ("height", "h", "高", "高度"))
        values = _values_after_word(text, word, 3)
        radius1 = radius1 if radius1 is not None else (values[0] if values else None)
        radius2 = radius2 if radius2 is not None else (values[1] if len(values) > 1 else None)
        height = height if height is not None else (values[2] if len(values) > 2 else None)
        missing = tuple(key for key, value in (("radius1", radius1), ("radius2", radius2), ("height", height)) if value is None)
        return ParsedCommand(kind=kind, arguments={"radius1": radius1, "radius2": radius2, "height": height, **origin},
                             missing=missing, reason="cone_parameters")
    if kind == "sphere":
        radius = _value(text, ("radius", "r", "半径"))
        values = _values_after_word(text, word, 1)
        radius = radius if radius is not None else (values[0] if values else None)
        missing = () if radius is not None else ("radius",)
        return ParsedCommand(kind=kind, arguments={"radius": radius, **origin}, missing=missing, reason="sphere_parameters")
    major = _value(text, ("majorRadius", "major", "大半径"))
    minor = _value(text, ("minorRadius", "minor", "小半径"))
    values = _values_after_word(text, word, 2)
    major = major if major is not None else (values[0] if values else None)
    minor = minor if minor is not None else (values[1] if len(values) > 1 else None)
    missing = tuple(key for key, value in (("majorRadius", major), ("minorRadius", minor)) if value is None)
    return ParsedCommand(kind=kind, arguments={"majorRadius": major, "minorRadius": minor, **origin},
                         missing=missing, reason="torus_parameters")


def _tube(text: str) -> ParsedCommand:
    outer = _value(text, ("outerRadius", "outer", "外半径", "外径"))
    inner = _value(text, ("innerRadius", "inner", "内半径", "内径"))
    height = _value(text, ("height", "h", "高", "高度"))
    values = _values_after_word(text, _TUBE_WORDS, 3)
    outer = outer if outer is not None else (values[0] if values else None)
    inner = inner if inner is not None else (values[1] if len(values) > 1 else None)
    height = height if height is not None else (values[2] if len(values) > 2 else None)
    missing = tuple(key for key, value in (("outer_radius", outer), ("inner_radius", inner), ("height", height)) if value is None)
    return ParsedCommand(kind="tube", arguments={"outer_radius": outer, "inner_radius": inner, "height": height},
                         missing=missing, reason="tube_parameters")


def _translate(text: str) -> ParsedCommand | None:
    if not re.search(r"(?:translate|move|平移|移动)", text, re.I):
        return None
    ref_match = re.search(r"(@?(?:body|feature|face|edge)[-_:/\w]*|Body[-_]?\w+)", text, re.I)
    reference = ref_match.group(1) if ref_match else None
    values: dict[str, float | None] = {}
    for axis in "xyz":
        values[axis] = _value(text, (axis, {"x": "dx", "y": "dy", "z": "dz"}[axis],
                                      {"x": "x方向", "y": "y方向", "z": "z方向"}[axis]))
    if any(value is None for value in values.values()):
        tail = text[ref_match.end():] if ref_match else text
        raw = [parse_length(f"{n}{u or 'mm'}") for n, u in re.findall(_VALUE, tail, re.I)]
        for axis, value in zip("xyz", raw):
            if values[axis] is None:
                values[axis] = value
    missing = tuple(key for key, value in (("reference", reference), ("dx", values["x"]),
                                            ("dy", values["y"]), ("dz", values["z"])) if value is None)
    return ParsedCommand(kind="translate", arguments={"dx": values["x"], "dy": values["y"], "dz": values["z"]},
                         reference=reference, missing=missing, reason="translation_parameters")


def _boolean(text: str) -> ParsedCommand | None:
    match = _BOOLEAN_WORDS.search(text)
    if not match:
        return None
    lowered = text.lower()
    if re.search(r"(?:fuse|union|合并|融合)", lowered):
        kind: Kind = "fuse"
    elif re.search(r"(?:common|intersection|相交)", lowered):
        kind = "common"
    else:
        kind = "cut"
    refs = re.findall(r"@?(?:body|feature)[-_:/\w]+", text, re.I)
    values = {"targetBody": refs[0] if len(refs) > 0 else None,
              "toolBody": refs[1] if len(refs) > 1 else None}
    missing = tuple(key for key, item in values.items() if item is None)
    return ParsedCommand(kind=kind, arguments=values, missing=missing, reason="boolean_entity_references")


def parse_command(text: str) -> ParsedCommand:
    value = text.strip().replace("×", "x")
    if _FILLET_WORDS.search(value):
        return _detail(value, "fillet")
    if _CHAMFER_WORDS.search(value):
        return _detail(value, "chamfer")
    if _PATTERN_WORDS.search(value):
        lowered = value.lower()
        if re.search(r"circular", lowered):
            return _pattern(value, "pattern_circular")
        if re.search(r"rectangular", lowered):
            return _pattern(value, "pattern_rectangular")
        if re.search(r"mirror", lowered):
            return _pattern(value, "pattern_mirror")
        return _pattern(value, "pattern_linear")
    if re.search(r"(?:set|assign|create)\s+material", value, re.I):
        return _material(value)
    translated = _translate(value)
    if translated is not None:
        return translated
    boolean = _boolean(value)
    if boolean is not None:
        return boolean
    if _TUBE_WORDS.search(value):
        return _tube(value)
    for kind, word in (("box", _BOX_WORDS), ("cylinder", _CYLINDER_WORDS), ("cone", _CONE_WORDS),
                       ("sphere", _SPHERE_WORDS), ("torus", _TORUS_WORDS)):
        if word.search(value):
            return _primitive(value, kind, word)
    return ParsedCommand(kind="unknown", reason="no_supported_cad_command")
