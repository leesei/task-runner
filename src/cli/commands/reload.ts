/**
 * `tq reload` command.
 *
 * Runs task discovery through the shared core, then writes a reload control
 * request so the live daemon refreshes its runner state. It never calls the
 * daemon HTTP API.
 */

import { openCliCore } from "../core.ts";

export async function commandReload(
  dataDir: string,
  daemonRunning: boolean,
  projectRoot: string,
  _flags: Record<string, string | true>,
): Promise<number> {
  if (!daemonRunning) {
    console.error("Error: daemon is not running. Start it with `tq daemon` first.");
    return 1;
  }

  let cli;
  try {
    cli = openCliCore(dataDir, { projectRoot });
  } catch (err: any) {
    console.error(`Error opening database: ${err.message}`);
    return 1;
  }

  try {
    const { loaded, warnings } = cli.core.reload();
    console.log(`Reloaded ${loaded} task(s)`);
    for (const warning of warnings) {
      console.warn(`Warning: ${warning}`);
    }

    if (!(await cli.core.requestReload())) {
      console.error("Error: daemon did not process the reload request in time");
      return 1;
    }

    return 0;
  } finally {
    cli.close();
  }
}
