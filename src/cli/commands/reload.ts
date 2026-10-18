/**
 * `tq reload` command.
 */

export async function commandReload(
  _daemonPort: number,
  _flags: Record<string, string | true>,
): Promise<number> {
  console.log("Reload command stub — real implementation in ticket 08/09");
  return 0;
}
