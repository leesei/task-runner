import { commandDaemon } from "./src/cli/commands/daemon.ts";
console.log("calling");
await commandDaemon("/tmp/debug-dd", 8820, {});
console.log("done");
