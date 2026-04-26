/// <reference types="node" />

export * from "./migration_keeper";

import { runCli } from "./migration_keeper/cli";

if (require.main === module) {
  runCli().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
