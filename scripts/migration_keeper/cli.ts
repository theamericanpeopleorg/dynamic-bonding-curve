import {
  DBC_PROGRAM_ID,
  DAMM_V2_CONFIG,
  DEFAULT_KEYPAIR_PATH,
  DEFAULT_RPC_URL,
  KeeperOptions,
  getDbcProgramId,
  parsePublicKey,
} from "./shared";
import { runKeeper } from "./keeper";

export function usage() {
  console.log(`Usage:
  bun scripts/migration_keeper/migration_keeper.ts <POOL_PUBKEY> [--rpc-url <URL>] [--dbc-program-id <PROGRAM_ID>] [--keypair <PATH>] [--withdraw-leftover] [--surplus-receiver <OWNER>]

Environment:
  RPC_URL            Optional default RPC URL
  KEYPAIR_PATH       Defaults to ${DEFAULT_KEYPAIR_PATH}

Defaults:
  DBC Program ID: ${DBC_PROGRAM_ID.toBase58()}
  DAMM v2 config: ${DAMM_V2_CONFIG.toBase58()}
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
  dbcProgramId?: string;
  keypairPath?: string;
  rpcUrl?: string;
  withdrawLeftover?: boolean;
  surplusReceiver?: string;
};

export function parseCliArgs(argv: string[]): ParsedCliArgs {
  let command: string | undefined;
  let dbcProgramId: string | undefined;
  let keypairPath: string | undefined;
  let rpcUrl: string | undefined;
  let withdrawLeftover = false;
  let surplusReceiver: string | undefined;

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

    if (arg === "--surplus-receiver") {
      surplusReceiver = readValue(
        argv,
        ++i,
        "--surplus-receiver requires an owner public key"
      );
      continue;
    }
    if (arg.startsWith("--surplus-receiver=")) {
      surplusReceiver = arg.slice("--surplus-receiver=".length);
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
    dbcProgramId,
    keypairPath,
    rpcUrl,
    withdrawLeftover,
    surplusReceiver,
  };
}

function buildKeeperOptions(args: ParsedCliArgs): KeeperOptions {
  if (!args.command) {
    throw new Error("Pool public key argument is required");
  }

  return {
    pool: parsePublicKey(args.command, "pool"),
    dammConfig: DAMM_V2_CONFIG,
    dbcProgramId: args.dbcProgramId
      ? parsePublicKey(args.dbcProgramId, "DBC program id")
      : getDbcProgramId(),
    keypairPath: args.keypairPath,
    rpcUrl: args.rpcUrl,
    withdrawLeftover: args.withdrawLeftover,
    surplusReceiver: args.surplusReceiver
      ? parsePublicKey(args.surplusReceiver, "surplus receiver")
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
