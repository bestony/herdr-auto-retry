/** Collapses all whitespace runs (including newlines) into single spaces. */
export function flatten(text: string): string {
  return text.split(/\s+/).filter(Boolean).join(" ");
}
