/**
 * `tq add <task> [context]` command.
 *
 * Validates input, enqueues an instance, prints its id.
 * Works offline (direct SQLite) when daemon is not reachable.
 */

export async function commandAdd(
  _dataDir: string,
  _daemonPort: number | null,
  args: string[],
  _flags: Record<string, string | true>,
): Promise<number> {
  if (args.length === 0) {
    console.error("Usage: tq add <task> [context]");
    return 2;
  }

  const taskId = args[0];
  // For now, just echo — the real implementation comes in later tickets
  console.log(`Task: ${taskId}`);
  console.log("Instance ID: 0 (stub - real implementation in ticket 08/09)");
  return 0;
}
