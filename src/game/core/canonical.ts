/** Canonical authoritative JSON: sorted record keys, ordered arrays, safe integers only. */
export function canonical(value: unknown): string {
  const ancestors = new Set<object>();
  let nodes = 0;
  function encode(item: unknown, depth: number): string {
    if (++nodes > 100_000 || depth > 64) throw new RangeError("Canonical state exceeds bounds");
    if (item === null || typeof item === "boolean" || typeof item === "string")
      return JSON.stringify(item);
    if (typeof item === "number" && Number.isSafeInteger(item))
      return String(item === 0 ? 0 : item);
    if (typeof item !== "object" || item === null)
      throw new TypeError("Noncanonical authoritative value");
    if (ancestors.has(item)) throw new TypeError("Cyclic authoritative state");
    ancestors.add(item);
    let result: string;
    if (Array.isArray(item)) {
      const parts: string[] = [];
      for (let index = 0; index < item.length; index++) {
        if (!Object.hasOwn(item, index)) throw new TypeError("Sparse authoritative array");
        parts.push(encode(item[index], depth + 1));
      }
      result = `[${parts.join(",")}]`;
    } else {
      if (
        Object.getPrototypeOf(item) !== Object.prototype &&
        Object.getPrototypeOf(item) !== null
      ) {
        throw new TypeError("Authoritative records must be plain objects");
      }
      if (Object.getOwnPropertySymbols(item).length)
        throw new TypeError("Symbol state keys are unsupported");
      const record = item as Record<string, unknown>;
      result = `{${Object.keys(record)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${encode(record[key], depth + 1)}`)
        .join(",")}}`;
    }
    ancestors.delete(item);
    return result;
  }
  return encode(value, 0);
}

/** Diagnostic FNV-1a over canonical UTF-16 code units; never an authentication/content digest. */
export function stateHash(value: unknown): string {
  const text = canonical(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++)
    hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193);
  return (hash >>> 0).toString(16).padStart(8, "0");
}
