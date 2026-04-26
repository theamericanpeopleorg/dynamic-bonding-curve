export * from "./cli";
export * from "./keeper";
export * from "./shared";

import { runCli } from "./cli";

if (require.main === module) {
  runCli().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
