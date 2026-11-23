/**
 * Structured logging.
 *
 * A plugin runs inside a sandboxed iframe with no devtools open most of the
 * time, so a log line that does not say WHERE a value came from is useless when
 * somebody reports "the jump went to the wrong place". Every call names the
 * operation and carries the identifiers needed to follow it, not just the
 * outcome.
 */

const PREFIX = '[strip]';

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

let debugEnabled = false;

/** Flipped by the index plugin from the "Verbose logging" setting. */
export function setDebugLogging(on: boolean): void {
  debugEnabled = on;
}

export function log(level: LogLevel, message: string, context: Record<string, unknown> = {}): void {
  if (level === 'DEBUG' && !debugEnabled) return;
  const line = `${PREFIX} ${message}`;
  if (level === 'ERROR') console.error(line, context);
  else if (level === 'WARN') console.warn(line, context);
  else console.log(line, context);
}

/**
 * Describe a thrown value for a log line.
 *
 * `String(err)` on a plain object gives "[object Object]", which is exactly the
 * log line you do not want to be reading at the point something has gone wrong.
 */
export function describeError(err: unknown): { name: string; message: string } {
  if (err instanceof Error) return { name: err.name, message: err.message };
  return { name: typeof err, message: String(err) };
}
