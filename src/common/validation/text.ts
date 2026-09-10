export function collapseWhitespace(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

export function countCodePoints(value: string): number {
  return Array.from(value).length;
}

export function countWords(value: string): number {
  const normalized = collapseWhitespace(value);
  return normalized.length === 0 ? 0 : normalized.split(/\s+/u).length;
}
