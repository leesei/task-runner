/**
 * `tq clear [--all] <queue>` command.
 */

export async function commandClear(
  _dataDir: string,
  _daemonPort: number | null,
  args: string[],
  _flags: Record<string, string | true>,
): Promise<number> {
  const all = args[0] === "--all";
  const queueId = all ? args[1] : args[0];

  if (!queueId) {
    console.error("Usage: tq clear [--all] <queue>");
    return 2;
  }

  console.log(`Clear command stub for queue: ${queueId}${all ? " (all)" : ""}`);
  return 0;
}
