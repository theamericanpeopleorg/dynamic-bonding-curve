/// <reference types="node" />

export * from "./dbc_tool";

import { runCli } from "./cli";

if (require.main === module) {
  runCli().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
