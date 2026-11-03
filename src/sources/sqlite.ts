/** node:sqlite still warns as experimental on Node 22. That noise is not useful to a CLI user. */
export async function loadSqlite(): Promise<typeof import('node:sqlite')> {
  const original = process.emitWarning;
  process.emitWarning = function (this: unknown, warning: string | Error, ...rest: unknown[]) {
    if (String(warning).includes('SQLite')) return;
    return (original as (...args: unknown[]) => void).call(process, warning, ...rest);
  } as typeof process.emitWarning;
  try {
    return await import('node:sqlite');
  } finally {
    process.emitWarning = original;
  }
}
