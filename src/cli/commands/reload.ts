/**
 * `tq reload` command.
 *
 * Reloads task definitions from the search path.
 * Requires the daemon to be running; sends POST /api/reload.
 */

export async function commandReload(
  daemonPort: number,
  _flags: Record<string, string | true>,
): Promise<number> {
  if (daemonPort === null) {
    console.error("Error: daemon is not running. Start it with `tq daemon` first.");
    return 1;
  }

  try {
    const res = await fetch(
      `http://localhost:${daemonPort}/api/reload`,
      { method: "POST" },
    );
    if (res.ok) {
      const body = (await res.json()) as { reloaded: number; warnings: string[] };
      console.log(`Reloaded ${body.reloaded} task(s)`);
      if (body.warnings.length > 0) {
        for (const w of body.warnings) {
          console.warn(`Warning: ${w}`);
        }
      }
      return 0;
    }
    const errBody = await res.text();
    console.error(`Daemon returned ${res.status}: ${errBody}`);
    return 1;
  } catch (err: any) {
    console.error(`Error: ${err.message}`);
    return 1;
  }
}

