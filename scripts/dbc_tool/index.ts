export * from "./shared";
export * from "./commands";
export * from "./cli";

import { runCli } from "./cli";

if (require.main === module) {
  runCli().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
