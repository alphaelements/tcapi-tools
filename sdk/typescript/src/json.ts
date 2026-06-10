/**
 * Wire-format JSON conversion. All SDKs serialize to identical JSON with
 * snake_case keys (docs/sdk-api-design.md §6); the TypeScript API uses
 * camelCase, so these helpers convert key style recursively.
 */

function camelToSnake(key: string): string {
  return key.replace(/([A-Z])/g, "_$1").toLowerCase();
}

function snakeToCamel(key: string): string {
  return key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

function mapKeys(value: unknown, mapper: (k: string) => string): JsonValue {
  if (Array.isArray(value)) {
    return value.map((v) => mapKeys(v, mapper));
  }
  if (value !== null && typeof value === "object") {
    const out: { [k: string]: JsonValue } = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[mapper(k)] = mapKeys(v, mapper);
    }
    return out;
  }
  return value as JsonValue;
}

/** Convert a camelCase API object to the snake_case wire form. */
export function toWire(value: unknown): JsonValue {
  return mapKeys(value, camelToSnake);
}

/** Convert a snake_case wire object to the camelCase API form. */
export function fromWire(value: unknown): JsonValue {
  return mapKeys(value, snakeToCamel);
}

/** Serialize a camelCase API object to a wire-format JSON string. */
export function toWireJson(value: unknown): string {
  return JSON.stringify(toWire(value));
}
