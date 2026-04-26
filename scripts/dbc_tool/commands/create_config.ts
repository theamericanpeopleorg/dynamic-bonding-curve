import { Program } from "@coral-xyz/anchor";
import {
  getCurrentPoint,
  getFeeMode,
  getPriceFromSqrtPrice,
  getSwapResultFromExactOutput,
  getSwapResultFromPartialInput,
  METAPLEX_PROGRAM_ID,
  MigrationOption,
  TokenDecimal,
  TokenType,
  TradeDirection,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SystemProgram,
} from "@solana/web3.js";
import BN from "bn.js";
import {
  buildClient,
  buildDefaultCurveConfig,
  getInitialBaseSupply,
  getQuoteDecimals,
  getTokenProgramForFlag,
  loadKeypair,
  MAINNET_USDC_MINT,
  amountToRaw,
  bnMin,
  deriveDbcPoolAddressForProgram,
  deriveDbcPoolAuthority,
  deriveDbcTokenVaultAddress,
  deriveMintMetadata,
  percent,
  rawAmountToUi,
  simulateAndSend,
  toBN,
  toNumber,
  tokenTypeLabel,
  type BuyOptions,
  type BuyResult,
  type CreateConfigOptions,
  type CreateConfigResult,
  type CreatePoolOptions,
  type CreatePoolResult,
  type PoolInfoOptions,
  type PoolInfoResult,
} from "../shared";

export async function createConfig(
  options: CreateConfigOptions = {}
): Promise<CreateConfigResult> {
  const { connection, program } = await buildClient(options.rpcUrl);
  const payer = options.payer ?? loadKeypair();
  const config = options.config ?? Keypair.generate();
  const feeClaimer = options.feeClaimer ?? payer.publicKey;
  const leftoverReceiver = options.leftoverReceiver ?? payer.publicKey;
  const quoteMint = options.quoteMint ?? MAINNET_USDC_MINT;

  const transaction = await program.methods
    .createConfig(buildDefaultCurveConfig())
    .accountsPartial({
      payer: payer.publicKey,
      config: config.publicKey,
      feeClaimer,
      leftoverReceiver,
      quoteMint,
    })
    .transaction();

  const signature = await simulateAndSend(connection, transaction, [
    payer,
    config,
  ]);

  return {
    config: config.publicKey,
    quoteMint,
    signature,
  };
}
