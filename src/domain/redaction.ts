const sensitiveKey =
  /authorization|cookie|secret|token|password|private.?key|environment|env|source|patch|command.?output/i;
const credentialPattern = /(bearer\s+|token=|api[_-]?key=)[^\s,;]+/gi;
const privateKeyPattern = /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*/g;

export type RedactionResult = Readonly<{
  value: unknown;
  redactionCount: number;
}>;

export const redact = (
  input: unknown,
  options: Readonly<{ environmentValues?: readonly string[] }> = {},
): RedactionResult => {
  let redactionCount = 0;
  const environmentValues = (options.environmentValues ?? []).filter(
    (value) => value.length > 0,
  );

  const visit = (value: unknown, key?: string): unknown => {
    if (key !== undefined && sensitiveKey.test(key)) {
      redactionCount += 1;
      return "[REDACTED]";
    }
    if (typeof value === "string") {
      let output = value.replace(credentialPattern, () => {
        redactionCount += 1;
        return "[REDACTED]";
      });
      output = output.replace(privateKeyPattern, () => {
        redactionCount += 1;
        return "[REDACTED]";
      });
      for (const environmentValue of environmentValues) {
        if (output.includes(environmentValue)) {
          redactionCount += 1;
          output = output.split(environmentValue).join("[REDACTED]");
        }
      }
      if (output.length > 500) {
        redactionCount += 1;
        return `[TRUNCATED ${String(output.length)} CHARACTERS]`;
      }
      return output;
    }
    if (Array.isArray(value)) return value.map((item) => visit(item));
    if (typeof value === "object" && value !== null) {
      return Object.fromEntries(
        Object.entries(value).map(([entryKey, entryValue]) => [
          entryKey,
          visit(entryValue, entryKey),
        ]),
      );
    }
    return value;
  };

  return { value: visit(input), redactionCount };
};
