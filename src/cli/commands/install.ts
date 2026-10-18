/**
 * `tq install <package>` command.
 */

export async function commandInstall(
  _dataDir: string,
  _daemonPort: number | null,
  args: string[],
  _flags: Record<string, string | true>,
): Promise<number> {
  if (args.length === 0) {
    console.error("Usage: tq install <package>");
    return 2;
  }

  const packageName = args[0];
  console.log(`Install command stub for package: ${packageName}`);
  return 0;
}
