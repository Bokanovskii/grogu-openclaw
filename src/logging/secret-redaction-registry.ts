import { AsyncLocalStorage } from "node:async_hooks";
import { pruneMapToMaxSize } from "../infra/map-size.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { escapeRegExp } from "../shared/regexp.js";

const MIN_SECRET_VALUE_LENGTH = 6;
const MAX_SECRET_VALUES = 512;

type SecretValueRedactor = (text: string, mask: (value: string, index: number) => string) => string;
type SecretRedactionRegistryState = {
  registeredValues: Map<string, true>;
  activeValues: Map<string, number>;
  registryRevision: number;
  registeredValueRedactor: SecretValueRedactor | undefined;
};

// Native and source module copies share membership and matcher invalidation.
const state = resolveGlobalSingleton<SecretRedactionRegistryState>(
  Symbol.for("openclaw.secretRedactionRegistry"),
  () => ({
    registeredValues: new Map<string, true>(),
    activeValues: new Map<string, number>(),
    registryRevision: 0,
    registeredValueRedactor: undefined,
  }),
);

export type SecretRedactionRegistrySnapshot = { revision: number; values: readonly string[] };
const registrySnapshots = resolveGlobalSingleton(
  Symbol.for("openclaw.secretRedactionRegistrySnapshots"),
  () =>
    new AsyncLocalStorage<{
      snapshot: SecretRedactionRegistrySnapshot;
      values: ReadonlySet<string>;
      redactor?: SecretValueRedactor;
    }>(),
);

/** A trusted worker task borrows captured policy without mutating its process registry. */
export function withSecretRedactionRegistrySnapshot<T>(
  snapshot: SecretRedactionRegistrySnapshot,
  run: () => T,
): T {
  return registrySnapshots.run({ snapshot, values: new Set(snapshot.values) }, run);
}

function invalidateMatcher(): void {
  state.registryRevision += 1;
  state.registeredValueRedactor = undefined;
}

function registerOneSecretValue(value: string): void {
  if (state.registeredValues.delete(value)) {
    state.registeredValues.set(value, true);
    return;
  }
  state.registeredValues.set(value, true);
  pruneMapToMaxSize(state.registeredValues, MAX_SECRET_VALUES);
  invalidateMatcher();
}

function secretValueForms(value: string, minimumLength = MIN_SECRET_VALUE_LENGTH): string[] {
  if (value.length < minimumLength) {
    return [];
  }
  // URL egress percent-encodes injected values; redact that surface form too.
  const encoded = encodeURIComponent(value);
  // Captured structured payloads are serialized before persistence, so retain
  // the JSON string-content form for credentials with escaped characters.
  const jsonEscaped = JSON.stringify(value).slice(1, -1);
  // Keep the raw value newest in the bounded registry.
  return [
    ...(encoded !== value ? [encoded] : []),
    ...(jsonEscaped !== value && jsonEscaped !== encoded ? [jsonEscaped] : []),
    value,
  ];
}

/** Registers one resolved secret for exact-value log redaction. */
export function registerSecretValueForRedaction(value: string): void {
  for (const form of secretValueForms(value)) {
    registerOneSecretValue(form);
  }
}

/** Holds exact-value redaction for the lifetime of a request. */
export function holdSecretValueForRedaction(value: string): () => void {
  let forms: string[] | undefined = secretValueForms(value, 1);
  for (const form of forms) {
    state.activeValues.set(form, (state.activeValues.get(form) ?? 0) + 1);
  }
  if (forms.length) {
    invalidateMatcher();
  }
  return () => {
    if (!forms) {
      return;
    }
    for (const form of forms) {
      const count = state.activeValues.get(form);
      if (count === 1) {
        state.activeValues.delete(form);
      } else if (count !== undefined) {
        state.activeValues.set(form, count - 1);
      }
    }
    if (forms.length) {
      invalidateMatcher();
    }
    forms = undefined;
  };
}

/** Returns whether a value has SecretRef provenance in the process registry. */
export function isSecretValueRegisteredForRedaction(value: string): boolean {
  const scoped = registrySnapshots.getStore();
  return scoped
    ? scoped.values.has(value)
    : state.registeredValues.has(value) || state.activeValues.has(value);
}

export function hasRegisteredSecretValuesForRedaction(): boolean {
  const scoped = registrySnapshots.getStore();
  return scoped
    ? scoped.values.size > 0
    : state.registeredValues.size > 0 || state.activeValues.size > 0;
}

/** Changes with registry membership, including bounded eviction and test resets. */
export function getSecretRedactionRegistryRevision(): number {
  return registrySnapshots.getStore()?.snapshot.revision ?? state.registryRevision;
}

/** Exact surface forms are already expanded; snapshots must not register them again. */
export function captureSecretRedactionRegistrySnapshot(): SecretRedactionRegistrySnapshot {
  const scoped = registrySnapshots.getStore();
  return scoped
    ? { revision: scoped.snapshot.revision, values: [...scoped.values] }
    : {
        revision: state.registryRevision,
        values: [...new Set([...state.registeredValues.keys(), ...state.activeValues.keys()])],
      };
}

/** Replaces registered exact values while preserving the caller's mask convention. */
export function redactRegisteredSecretValues(
  text: string,
  mask: (value: string, index: number) => string,
): string {
  const scoped = registrySnapshots.getStore();
  if (scoped) {
    scoped.redactor ??= createSecretValueRedactor(scoped.snapshot.values);
    return scoped.redactor(text, mask);
  }
  if (!text || (state.registeredValues.size === 0 && state.activeValues.size === 0)) {
    return text;
  }
  state.registeredValueRedactor ??= createSecretValueRedactor(
    captureSecretRedactionRegistrySnapshot().values,
  );
  return state.registeredValueRedactor(text, mask);
}

export function createSecretValueRedactor(values: readonly string[]): SecretValueRedactor {
  let compiledMatcher: { prefixes: RegExp; buckets: Map<string, string[]> } | undefined;
  let firstChars: Set<string> | undefined;
  return (text, mask) => {
    if (!text || values.length === 0) {
      return text;
    }
    let couldMatch = false;
    // Registration can add several surface forms; prepare their probe once on first use.
    firstChars ??= new Set(values.map((value) => value.charAt(0)));
    for (const firstChar of firstChars) {
      if (text.includes(firstChar)) {
        couldMatch = true;
        break;
      }
    }
    if (!couldMatch) {
      return text;
    }
    if (!compiledMatcher) {
      const buckets = new Map<string, string[]>();
      const prefixLength = values.reduce(
        (length, value) => Math.min(length, value.length),
        MIN_SECRET_VALUE_LENGTH,
      );
      for (const value of values.toSorted((left, right) => right.length - left.length)) {
        const prefix = value.slice(0, prefixLength);
        const bucket = buckets.get(prefix);
        if (bucket) {
          bucket.push(value);
        } else {
          buckets.set(prefix, [value]);
        }
      }
      // Supported store values can exceed the regex engine's literal span limit.
      // Compile fixed-width prefixes; verify complete values against the text.
      compiledMatcher = {
        prefixes: new RegExp([...buckets.keys()].map(escapeRegExp).join("|"), "g"),
        buckets,
      };
    }
    const { prefixes, buckets } = compiledMatcher;
    const matches: { index: number; value: string }[] = [];
    prefixes.lastIndex = 0;
    for (let match = prefixes.exec(text); match; match = prefixes.exec(text)) {
      const index = match.index;
      const value = buckets.get(match[0])?.find((candidate) => text.startsWith(candidate, index));
      if (value !== undefined) {
        matches.push({ index, value });
      }
      // A rejected prefix may overlap a real match beginning one code unit later.
      prefixes.lastIndex = index + (value?.length ?? 1);
    }
    // Global replacement fixes its matches before callbacks. Nested registration
    // must affect the next/nested call, never the remainder of this one.
    let result = "";
    let cursor = 0;
    for (const match of matches) {
      result += `${text.slice(cursor, match.index)}${mask(match.value, match.index)}`;
      cursor = match.index + match.value.length;
    }
    return result + text.slice(cursor);
  };
}

function resetSecretRedactionRegistryForTest(): void {
  state.registeredValues.clear();
  state.activeValues.clear();
  invalidateMatcher();
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.secretRedactionRegistryTestApi")
  ] = { resetSecretRedactionRegistryForTest };
}
