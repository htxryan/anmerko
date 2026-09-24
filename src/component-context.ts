export const COMPONENT_CONTEXT_KEY = 'anmerko:capture-component-context';
export const COMPONENT_CONTEXT_DEFAULT = false;
export const COMPONENT_CONTEXT_MAX_PATH_LENGTH = 8;
export const COMPONENT_CONTEXT_MAX_NAME_CODE_POINTS = 64;
export const COMPONENT_CONTEXT_MAX_TOTAL_NAME_CODE_POINTS = 384;
export const COMPONENT_CONTEXT_MAX_WIRE_BYTES = 2_048;
export const COMPONENT_CONTEXT_MAX_TRAVERSAL_LINKS = 64;

interface ComponentPathV1 {
  version: 1;
  path: string[];
  truncated: boolean;
}

export type ComponentContextV1 = ComponentPathV1 & (
  | { framework: 'react'; provenance: 'react-dom-fiber-dev' }
  | { framework: 'vue'; provenance: 'vue3-instance-debug' }
  | { framework: 'angular'; provenance: 'angular-debug-ownership' }
  | { framework: 'preact'; provenance: 'preact-vnode-prod' }
);

const CONTEXT_KEYS = ['version', 'framework', 'provenance', 'path', 'truncated'] as const;
const PAIRS = {
  react: 'react-dom-fiber-dev',
  vue: 'vue3-instance-debug',
  angular: 'angular-debug-ownership',
  preact: 'preact-vnode-prod',
} as const;

function dataProperties(value: object, expectedKeys: readonly string[]): Record<string, unknown> | undefined {
  try {
    const keys = Reflect.ownKeys(value);
    if (keys.length !== expectedKeys.length || keys.some(key => typeof key !== 'string' || !expectedKeys.includes(key))) return undefined;
    const properties: Record<string, unknown> = {};
    for (const key of expectedKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor)) return undefined;
      properties[key] = descriptor.value;
    }
    return properties;
  } catch {
    return undefined;
  }
}

function pathValues(value: unknown): string[] | undefined {
  try {
    if (!Array.isArray(value)) return undefined;
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
    if (!lengthDescriptor || !('value' in lengthDescriptor) || !Number.isInteger(lengthDescriptor.value)
      || lengthDescriptor.value < 1 || lengthDescriptor.value > COMPONENT_CONTEXT_MAX_PATH_LENGTH) return undefined;
    const length = lengthDescriptor.value as number;
    const expectedKeys = [...Array.from({ length }, (_, index) => String(index)), 'length'];
    const properties = dataProperties(value, expectedKeys);
    if (!properties) return undefined;
    const path: string[] = [];
    let totalCodePoints = 0;
    for (let index = 0; index < length; index++) {
      const name = properties[String(index)];
      // Bound code-unit work before scanning page/storage-provided strings.
      if (typeof name !== 'string' || name.length > COMPONENT_CONTEXT_MAX_NAME_CODE_POINTS * 2
        || !/\S/u.test(name) || /[\p{Cc}\p{Bidi_Control}\p{Zl}\p{Zp}]/u.test(name)) return undefined;
      const codePoints = Array.from(name).length;
      if (codePoints > COMPONENT_CONTEXT_MAX_NAME_CODE_POINTS) return undefined;
      totalCodePoints += codePoints;
      if (totalCodePoints > COMPONENT_CONTEXT_MAX_TOTAL_NAME_CODE_POINTS) return undefined;
      path.push(name);
    }
    return path;
  } catch {
    return undefined;
  }
}

export function normalizeComponentContext(value: unknown): ComponentContextV1 | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const properties = dataProperties(value, CONTEXT_KEYS);
  if (!properties || properties.version !== 1 || typeof properties.framework !== 'string'
    || typeof properties.provenance !== 'string' || typeof properties.truncated !== 'boolean') return undefined;
  if (!(properties.framework in PAIRS)
    || PAIRS[properties.framework as keyof typeof PAIRS] !== properties.provenance) return undefined;
  const path = pathValues(properties.path);
  if (!path) return undefined;

  // Proxies are not valid structured data. Descriptor inspection above ensures
  // this check cannot invoke an accessor on either the DTO or its path.
  try { structuredClone(value); } catch { return undefined; }

  const context = {
    version: 1 as const,
    framework: properties.framework,
    provenance: properties.provenance,
    path,
    truncated: properties.truncated,
  } as ComponentContextV1;
  if (new TextEncoder().encode(JSON.stringify(context)).byteLength > COMPONENT_CONTEXT_MAX_WIRE_BYTES) return undefined;
  return context;
}
