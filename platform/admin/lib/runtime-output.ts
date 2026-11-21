// Turns a local runtime's stderr into the reason a failed endpoint shows. The
// runtime prints one line {"fatal": "<message>"} when it cannot start
// (platform/runtime/src/local.ts); a stack trace's last lines say nothing.
const TAIL = 3;

export function startupFailure(lines: readonly string[]): string {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim() ?? '';
    if (!line.startsWith('{"fatal"')) continue;
    try {
      const { fatal } = JSON.parse(line) as { fatal?: unknown };
      if (typeof fatal === 'string' && fatal) return fatal;
    } catch {
      // not the runtime's line
    }
  }
  return lines.slice(-TAIL).join(' | ') || 'no output';
}
