/** Presentation only. Never feed rounded display values back to CAD commands. */
export function engineeringNumber(value: unknown, significantDigits = 8): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  if (!Number.isInteger(significantDigits) || significantDigits < 1 || significantDigits > 15) throw new RangeError("Display precision must be between 1 and 15 significant digits.");
  if (value === 0) return "0";
  const rounded = Number(value.toPrecision(significantDigits));
  if (Math.abs(rounded) >= 1e-4 && Math.abs(rounded) < 1e7) return String(rounded);
  // Derive the coefficient from an exponent string, not 10**exponent:
  // that divisor underflows for subnormal Float64 values.
  const [mantissa, exponentText] = value.toExponential(significantDigits - 1).split("e");
  const exponent = Number(exponentText), engineeringExponent = Math.floor(exponent / 3) * 3;
  const coefficient = Number((Number(mantissa) * 10 ** (exponent - engineeringExponent)).toPrecision(significantDigits));
  return `${coefficient}e${engineeringExponent >= 0 ? "+" : ""}${engineeringExponent}`;
}

export function fullPrecisionNumber(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? String(Object.is(value, -0) ? 0 : value) : "—";
}
