export function isCuratedMemoryRoot(relativePath: string): boolean {
  return relativePath === "MEMORY.md" || relativePath === "memory.md" || relativePath === "USER.md";
}
