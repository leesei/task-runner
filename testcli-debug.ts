import { main } from "./src/cli/index.ts";
const code = await main(["tq", "daemon", "--help"]);
console.log("CODE", code);
