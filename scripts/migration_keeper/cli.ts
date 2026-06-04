import {
  DBC_PROGRAM_ID,
  DEFAULT_KEYPAIR_PATH,
  DEFAULT_RPC_URL,
  KeeperOptions,
  getDbcProgramId,
  parsePublicKey,
} from "./shared";
import { runKeeper } from "./keeper";

export function usage() {
  console.log(`Usage:
  bun scripts/migration_keeper/migration_keeper.ts <POOL_PUBKEY> --damm-config <DAMM_V2_CONFIG> [--rpc-url <URL>] [--dbc-program-id <PROGRAM_ID>] [--keypair <PATH>] [--withdraw-leftover] [--migration-fee-receiver <OWNER>]

Environment:
  RPC_URL            Optional default RPC URL
  KEYPAIR_PATH       Defaults to ${DEFAULT_KEYPAIR_PATH}

Defaults:
  DBC Program ID: ${DBC_PROGRAM_ID.toBase58()}
  RPC URL:        ${DEFAULT_RPC_URL}
`);
}

export async function runCli() {
  const args = parseCliArgs(process.argv.slice(2));
  if (args.command === "--help" || args.command === "-h") {
    usage();
    return;
  }
  if (!args.command) {
    usage();
    throw new Error("Pool public key argument is required");
  }

  const options = buildKeeperOptions(args);
  await runKeeper(options);
}

export type ParsedCliArgs = {
  command?: string;
  dammConfig?: string;
  dbcProgramId?: string;
  keypairPath?: string;
  rpcUrl?: string;
  withdrawLeftover?: boolean;
  migrationFeeReceiver?: string;
};

export function parseCliArgs(argv: string[]): ParsedCliArgs {
  let command: string | undefined;
  let dammConfig: string | undefined;
  let dbcProgramId: string | undefined;
  let keypairPath: string | undefined;
  let rpcUrl: string | undefined;
  let withdrawLeftover = false;
  let migrationFeeReceiver: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === "--rpc-url") {
      rpcUrl = readValue(argv, ++i, "--rpc-url requires a URL value");
      continue;
    }
    if (arg.startsWith("--rpc-url=")) {
      rpcUrl = arg.slice("--rpc-url=".length);
      continue;
    }

    if (arg === "--dbc-program-id") {
      dbcProgramId = readValue(
        argv,
        ++i,
        "--dbc-program-id requires a public key"
      );
      continue;
    }
    if (arg.startsWith("--dbc-program-id=")) {
      dbcProgramId = arg.slice("--dbc-program-id=".length);
      continue;
    }

    if (arg === "--damm-config") {
      dammConfig = readValue(argv, ++i, "--damm-config requires a public key");
      continue;
    }
    if (arg.startsWith("--damm-config=")) {
      dammConfig = arg.slice("--damm-config=".length);
      continue;
    }

    if (arg === "--keypair") {
      keypairPath = readValue(argv, ++i, "--keypair requires a file path");
      continue;
    }
    if (arg.startsWith("--keypair=")) {
      keypairPath = arg.slice("--keypair=".length);
      continue;
    }

    if (arg === "--withdraw-leftover") {
      withdrawLeftover = true;
      continue;
    }

    if (arg === "--migration-fee-receiver") {
      migrationFeeReceiver = readValue(
        argv,
        ++i,
        "--migration-fee-receiver requires an owner public key"
      );
      continue;
    }
    if (arg.startsWith("--migration-fee-receiver=")) {
      migrationFeeReceiver = arg.slice("--migration-fee-receiver=".length);
      continue;
    }

    if (!command) {
      command = arg;
      continue;
    }

    throw new Error(`Unexpected argument: ${arg}`);
  }

  return {
    command,
    dammConfig,
    dbcProgramId,
    keypairPath,
    rpcUrl,
    withdrawLeftover,
    migrationFeeReceiver,
  };
}

function buildKeeperOptions(args: ParsedCliArgs): KeeperOptions {
  if (!args.command) {
    throw new Error("Pool public key argument is required");
  }
  if (!args.dammConfig) {
    throw new Error("--damm-config is required");
  }

  return {
    pool: parsePublicKey(args.command, "pool"),
    dammConfig: parsePublicKey(args.dammConfig, "damm config"),
    dbcProgramId: args.dbcProgramId
      ? parsePublicKey(args.dbcProgramId, "DBC program id")
      : getDbcProgramId(),
    keypairPath: args.keypairPath,
    rpcUrl: args.rpcUrl,
    withdrawLeftover: args.withdrawLeftover,
    migrationFeeReceiver: args.migrationFeeReceiver
      ? parsePublicKey(args.migrationFeeReceiver, "migration fee receiver")
      : undefined,
  };
}

function readValue(
  argv: string[],
  index: number,
  errorMessage: string
): string {
  const value = argv[index];
  if (!value) {
    throw new Error(errorMessage);
  }
  return value;
}
