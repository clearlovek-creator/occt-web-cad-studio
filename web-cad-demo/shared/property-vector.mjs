/** @param {unknown} value @returns {value is [number|string, number|string, number|string]} */
export function isPropertyVector(value) {
  return Array.isArray(value) && value.length === 3 && Array.from(value).every(part =>
    typeof part === 'number' ? Number.isFinite(part) :
      typeof part === 'string' && part.trim().length > 0 && new TextEncoder().encode(part).length <= 512);
}

/** Split only at commas between components, preserving function arguments.
 * @param {string} text
 */
export function splitPropertyVector(text) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === '(') depth++;
    else if (char === ')') depth--;
    else if (char === ',' && depth === 0) {
      parts.push(text.slice(start, index));
      start = index + 1;
    }
    if (depth < 0) return [];
  }
  return depth === 0 ? [...parts, text.slice(start)] : [];
}
