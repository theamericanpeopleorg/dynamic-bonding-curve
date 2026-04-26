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

export async function createPool(
  config: PublicKey | string,
  options: CreatePoolOptions = {}
): Promise<CreatePoolResult> {
  const { connection, program, programId } = await buildClient(options.rpcUrl);
  const payer = options.payer ?? loadKeypair();
  const poolCreator = options.poolCreator ?? payer;
  const baseMint = options.baseMint ?? Keypair.generate();
  const configPublicKey =
    typeof config === "string" ? new PublicKey(config) : config;

  const poolConfig = (await (program.account as any).poolConfig.fetch(
    configPublicKey
  )) as {
    quoteMint: PublicKey;
    tokenType: number;
    quoteTokenFlag?: number;
  };
  const quoteMint = new PublicKey(poolConfig.quoteMint);
  const pool = deriveDbcPoolAddressForProgram(
    quoteMint,
    baseMint.publicKey,
    configPublicKey,
    programId
  );
  const baseVault = deriveDbcTokenVaultAddress(
    baseMint.publicKey,
    pool,
    programId
  );
  const quoteVault = deriveDbcTokenVaultAddress(quoteMint, pool, programId);
  const poolAuthority = deriveDbcPoolAuthority(programId);
  const tokenQuoteProgram = getTokenProgramForFlag(
    Number(poolConfig.quoteTokenFlag ?? 0)
  );
  const poolParams = {
    name: options.name ?? "VoteToken",
    symbol: options.symbol ?? "VOTE",
    uri: options.uri ?? "https://example.com/localnet-dbc-token.json",
  };

  const transaction =
    Number(poolConfig.tokenType) === TokenType.Token2022
      ? await program.methods
          .initializeVirtualPoolWithToken2022(poolParams)
          .accountsPartial({
            baseMint: baseMint.publicKey,
            config: configPublicKey,
            creator: poolCreator.publicKey,
            payer: payer.publicKey,
            pool,
            poolAuthority,
            baseVault,
            quoteVault,
            quoteMint,
            tokenQuoteProgram,
            tokenProgram: TOKEN_2022_PROGRAM_ID,
          })
          .transaction()
      : await program.methods
          .initializeVirtualPoolWithSplToken(poolParams)
          .accountsPartial({
            baseMint: baseMint.publicKey,
            config: configPublicKey,
            creator: poolCreator.publicKey,
            payer: payer.publicKey,
            pool,
            poolAuthority,
            baseVault,
            quoteVault,
            quoteMint,
            mintMetadata: deriveMintMetadata(baseMint.publicKey),
            metadataProgram: METAPLEX_PROGRAM_ID,
            tokenQuoteProgram,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .transaction();

  const signature = await simulateAndSend(connection, transaction, [
    payer,
    baseMint,
    poolCreator,
  ]);
  return {
    pool,
    baseMint: baseMint.publicKey,
    signature,
  };
}
