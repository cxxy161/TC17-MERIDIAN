export type ConsoleValue =
  | {
      kind: 'primitive';
      valType: 'undefined' | 'null' | 'boolean' | 'number' | 'string' | 'bigint' | 'symbol';
      display: string;
    }
  | { kind: 'function'; name: string }
  | { kind: 'circular' }
  | { kind: 'truncated'; label: string }
  | {
      kind: 'array';
      length: number;
      preview: string;
      items: Array<{ key: string; value: ConsoleValue }>;
    }
  | {
      kind: 'object';
      tag: string;
      size: number;
      preview: string;
      entries: Array<{ key: string; value: ConsoleValue }>;
    };

function inlinePreview(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'string') {
    const s = value.length > 24 ? `${value.slice(0, 24)}…` : value;
    return JSON.stringify(s);
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  if (typeof value === 'symbol') return value.toString();
  if (typeof value === 'function') return `ƒ ${value.name || 'anonymous'}()`;
  if (Array.isArray(value)) return `Array(${value.length})`;
  if (value instanceof Date) return `Date(${value.toISOString()})`;
  if (value instanceof RegExp) return String(value);
  if (value instanceof Map) return `Map(${value.size})`;
  if (value instanceof Set) return `Set(${value.size})`;
  return '{…}';
}

/** Convert an arbitrary JS value (including Proxies, functions, errors, arrays) into a safe collapsed-friendly node. */
export function toConsoleValue(
  value: unknown,
  depth = 0,
  seen: WeakSet<object> = new WeakSet(),
): ConsoleValue {
  if (value === undefined) {
    return { kind: 'primitive', valType: 'undefined', display: 'undefined' };
  }
  if (value === null) {
    return { kind: 'primitive', valType: 'null', display: 'null' };
  }
  const t = typeof value;
  if (t === 'boolean' || t === 'number' || t === 'bigint' || t === 'symbol') {
    return { kind: 'primitive', valType: t, display: String(value) };
  }
  if (t === 'string') {
    return { kind: 'primitive', valType: 'string', display: JSON.stringify(value) };
  }
  if (t === 'function') {
    return { kind: 'function', name: (value as (...args: unknown[]) => unknown).name || '' };
  }

  const obj = value as object;
  if (seen.has(obj)) {
    return { kind: 'circular' };
  }
  if (depth >= 6) {
    return { kind: 'truncated', label: inlinePreview(value) };
  }

  if (obj instanceof Date) {
    return { kind: 'primitive', valType: 'string', display: `Date(${obj.toISOString()})` };
  }
  if (obj instanceof RegExp) {
    return { kind: 'primitive', valType: 'string', display: String(obj) };
  }

  seen.add(obj);
  try {
    if (Array.isArray(obj)) {
      const previewParts = obj.slice(0, 4).map((el) => inlinePreview(el));
      if (obj.length > 4) previewParts.push(`… +${obj.length - 4}`);
      const items = obj.slice(0, 100).map((el, idx) => ({
        key: String(idx),
        value: toConsoleValue(el, depth + 1, seen),
      }));
      if (obj.length > 100) {
        items.push({
          key: '…',
          value: { kind: 'truncated', label: `其余 ${obj.length - 100} 项已省略` },
        });
      }
      return {
        kind: 'array',
        length: obj.length,
        preview: `[${previewParts.join(', ')}]`,
        items,
      };
    }

    if (obj instanceof Map) {
      const all = Array.from(obj.entries());
      const previewParts = all.slice(0, 3).map(([k, v]) => `${inlinePreview(k)} => ${inlinePreview(v)}`);
      if (all.length > 3) previewParts.push('…');
      return {
        kind: 'object',
        tag: `Map(${obj.size})`,
        size: obj.size,
        preview: `{${previewParts.join(', ')}}`,
        entries: all.slice(0, 80).map(([k, v], i) => ({
          key: `${i}: ${inlinePreview(k)}`,
          value: toConsoleValue(v, depth + 1, seen),
        })),
      };
    }

    if (obj instanceof Set) {
      const all = Array.from(obj.values());
      const previewParts = all.slice(0, 4).map((v) => inlinePreview(v));
      if (all.length > 4) previewParts.push('…');
      return {
        kind: 'object',
        tag: `Set(${obj.size})`,
        size: obj.size,
        preview: `{${previewParts.join(', ')}}`,
        entries: all.slice(0, 80).map((v, i) => ({
          key: String(i),
          value: toConsoleValue(v, depth + 1, seen),
        })),
      };
    }

    let tag = '';
    if (obj instanceof Error) {
      tag = obj.name || 'Error';
    } else {
      const ctorName = (obj as { constructor?: { name?: string } }).constructor?.name;
      if (ctorName && ctorName !== 'Object') tag = ctorName;
    }

    const keys = Object.keys(obj);
    if (obj instanceof Error && !keys.includes('message')) {
      keys.unshift('message');
    }
    const entries: Array<{ key: string; value: ConsoleValue }> = [];
    const previewParts: string[] = [];

    for (const k of keys.slice(0, 120)) {
      let propVal: unknown;
      try {
        propVal = (obj as Record<string, unknown>)[k];
      } catch (err) {
        propVal = `[Getter Error: ${err instanceof Error ? err.message : String(err)}]`;
      }
      if (previewParts.length < 4) {
        previewParts.push(`${k}: ${inlinePreview(propVal)}`);
      }
      entries.push({
        key: k,
        value: toConsoleValue(propVal, depth + 1, seen),
      });
    }
    if (keys.length > 4) {
      previewParts.push('…');
    }

    return {
      kind: 'object',
      tag,
      size: keys.length,
      preview: keys.length === 0 ? '{}' : `{${previewParts.join(', ')}}`,
      entries,
    };
  } finally {
    seen.delete(obj);
  }
}

/** Try parsing a raw message (or trailing JSON payload) into structured ConsoleValue segments. */
export function parseMessageToSegments(message: string): Array<string | ConsoleValue> | null {
  const trimmed = message.trim();
  if (!trimmed) return null;

  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed !== null && typeof parsed === 'object') {
        return [toConsoleValue(parsed)];
      }
    } catch {
      // fall through
    }
  }

  // Also detect trailing JSON object/array after a prefix label, e.g. "[DEBUG] {\"a\":1}"
  const idxObj = trimmed.indexOf('{');
  const idxArr = trimmed.indexOf('[');
  const startIdx =
    idxObj >= 0 && idxArr >= 0 ? Math.min(idxObj, idxArr) : Math.max(idxObj, idxArr);
  if (startIdx > 0) {
    const prefix = trimmed.slice(0, startIdx).trimEnd();
    const tail = trimmed.slice(startIdx);
    if ((tail.startsWith('{') && tail.endsWith('}')) || (tail.startsWith('[') && tail.endsWith(']'))) {
      try {
        const parsed = JSON.parse(tail);
        if (parsed !== null && typeof parsed === 'object') {
          return [prefix, toConsoleValue(parsed)];
        }
      } catch {
        // ignore
      }
    }
  }

  return null;
}
