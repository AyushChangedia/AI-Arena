/**
 * Extracts the first complete, valid JSON object from a block of text.
 *
 * Scanning from the first `{` to the last `}` is the obvious implementation and
 * it is wrong: tool output routinely contains more than one object (a printed
 * result followed by an `[exports]` line, say), and the naive span covers both
 * and parses as neither. This tracks brace depth and string state and returns
 * the first candidate that actually parses.
 */
export function extractJsonObject(text: string): string | null {
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "{") continue;

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let j = i; j < text.length; j++) {
      const c = text[j]!;

      if (inString) {
        if (escaped) escaped = false;
        else if (c === "\\") escaped = true;
        else if (c === '"') inString = false;
        continue;
      }
      if (c === '"') {
        inString = true;
        continue;
      }
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) {
          const candidate = text.slice(i, j + 1);
          try {
            JSON.parse(candidate);
            return candidate;
          } catch {
            break; // Not valid: resume the outer scan past this opening brace.
          }
        }
      }
    }
  }
  return null;
}
