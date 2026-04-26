/// <reference types="node" />

import { readFileSync } from "fs";
import { homedir } from "os";
import path from "path";
import { AnchorProvider, Program } from "@coral-xyz/anchor";
import {
  DYNAMIC_BONDING_CURVE_PROGRAM_ID,
  DynamicBondingCurveIdl,
  TokenType,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  Commitment,
  Connection,
  Keypair,
  PublicKey,
  Signer,
  Transaction,
} from "@solana/web3.js";

export const DEFAULT_RPC_URL = "http://127.0.0.1:8899";
export const DEFAULT_COMMITMENT: Commitment = "confirmed";
export const DEFAULT_KEYPAIR_PATH = path.join(
  homedir(),
  ".config/solana/id.json"
);

export enum MigrationProgress {
  PreBondingCurve = 0,
  PostBondingCurve = 1,
  LockedVesting = 2,
  CreatedPool = 3,
}

export type KeeperOptions = {
  pool: PublicKey;
  dammConfig: PublicKey;
  rpcUrl?: string;
  dbcProgramId?: PublicKey;
  keypairPath?: string;
};

export type KeeperResult = {
  action: "migrated" | "already_migrated" | "externally_migrated";
  pool: PublicKey;
  config?: PublicKey;
  dammConfig: PublicKey;
  dammPool?: PublicKey;
  firstPosition?: PublicKey;
  secondPosition?: PublicKey;
  signature?: string;
};

export function getRpcUrl(rpcUrl?: string): string {
  return rpcUrl ?? process.env.RPC_URL ?? DEFAULT_RPC_URL;
}

export function getDbcProgramId(dbcProgramId?: PublicKey): PublicKey {
  return dbcProgramId ?? DYNAMIC_BONDING_CURVE_PROGRAM_ID;
}

export function loadKeypair(keypairPath = process.env.KEYPAIR_PATH): Keypair {
  const resolvedPath = keypairPath ?? DEFAULT_KEYPAIR_PATH;
  const bytes = JSON.parse(readFileSync(resolvedPath, "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(bytes));
}

export function parsePublicKey(value: string, name: string): PublicKey {
  try {
    return new PublicKey(value);
  } catch {
    throw new Error(`${name} must be a valid public key: ${value}`);
  }
}

export function buildClient(rpcUrl?: string, dbcProgramId?: PublicKey) {
  const resolvedRpcUrl = getRpcUrl(rpcUrl);
  const programId = getDbcProgramId(dbcProgramId);
  const connection = new Connection(resolvedRpcUrl, DEFAULT_COMMITMENT);
  const provider = new AnchorProvider(connection, null as any, {
    commitment: DEFAULT_COMMITMENT,
  });
  const idl = JSON.parse(JSON.stringify(DynamicBondingCurveIdl));
  idl.address = programId.toBase58();
  const program = new Program(idl, provider);

  return {
    connection,
    program,
    programId,
    rpcUrl: resolvedRpcUrl,
  };
}

export function deriveDbcPoolAuthority(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("pool_authority")],
    programId
  )[0];
}

export function deriveDammV2MigrationMetadata(
  pool: PublicKey,
  dbcProgramId: PublicKey
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("damm_v2"), pool.toBuffer()],
    dbcProgramId
  )[0];
}

export function getTokenProgramForFlag(tokenFlag: number): PublicKey {
  return tokenFlag === TokenType.Token2022
    ? TOKEN_2022_PROGRAM_ID
    : TOKEN_PROGRAM_ID;
}

export function migrationProgressLabel(value: number): string {
  return (
    [
      "pre_bonding_curve",
      "post_bonding_curve",
      "locked_vesting",
      "created_pool",
    ][value] ?? `unknown_${value}`
  );
}

export function publicKeyResultToBase58<T extends Record<string, unknown>>(
  result: T
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(result).map(([key, value]) => [
      key,
      isPublicKeyLike(value) ? value.toBase58() : value,
    ])
  );
}

export function logEvent(event: Record<string, unknown>) {
  console.log(JSON.stringify(event));
}

export async function signSendAndConfirm(
  connection: Connection,
  transaction: Transaction,
  signers: Signer[]
): Promise<string> {
  const uniqueSigners = Array.from(
    new Map(
      signers.map((signer) => [signer.publicKey.toBase58(), signer])
    ).values()
  );
  const latestBlockhash = await connection.getLatestBlockhash(
    DEFAULT_COMMITMENT
  );
  transaction.feePayer = uniqueSigners[0].publicKey;
  transaction.recentBlockhash = latestBlockhash.blockhash;
  transaction.sign(...uniqueSigners);

  const signature = await connection.sendRawTransaction(
    transaction.serialize(),
    {
      skipPreflight: false,
      preflightCommitment: DEFAULT_COMMITMENT,
    }
  );

  await connection.confirmTransaction(
    {
      signature,
      ...latestBlockhash,
    },
    DEFAULT_COMMITMENT
  );

  return signature;
}

function isPublicKeyLike(value: unknown): value is { toBase58(): string } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { toBase58?: unknown }).toBase58 === "function"
  );
}
