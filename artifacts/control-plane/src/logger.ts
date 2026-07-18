/** Minimal structured-ish logger — keeps the bundle dependency-free. */
type Fields = Record<string, unknown>;

function emit(level: string, a: Fields | string, b?: string): void {
  const msg = typeof a === "string" ? a : b ?? "";
  const fields = typeof a === "string" ? undefined : a;
  const line = `[${new Date().toISOString()}] ${level} ${msg}`;
  if (fields && Object.keys(fields).length > 0) {
    // eslint-disable-next-line no-console
    console.log(line, JSON.stringify(fields));
  } else {
    // eslint-disable-next-line no-console
    console.log(line);
  }
}

export const logger = {
  info: (a: Fields | string, b?: string) => emit("INFO", a, b),
  warn: (a: Fields | string, b?: string) => emit("WARN", a, b),
  error: (a: Fields | string, b?: string) => emit("ERROR", a, b),
};
