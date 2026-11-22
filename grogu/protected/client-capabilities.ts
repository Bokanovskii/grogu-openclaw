export const clientCapabilitiesVary = "X-Alcove-Capabilities";

export function hasClientCapability(headers: Headers, capability: string): boolean {
  return (
    headers
      .get(clientCapabilitiesVary)
      ?.split(",")
      .some((value) => value.trim() === capability) ?? false
  );
}
