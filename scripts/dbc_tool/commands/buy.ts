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

export async function buy(
  pool: PublicKey | string,
  amount: string | number | BN,
  options: BuyOptions = {}
): Promise<BuyResult> {
  const { connection, program, programId } = await buildClient(options.rpcUrl);
  const payer = options.payer ?? loadKeypair();
  const poolPublicKey = typeof pool === "string" ? new PublicKey(pool) : pool;
  const poolState = (await (program.account as any).virtualPool.fetch(
    poolPublicKey
  )) as any;
  const configPublicKey = new PublicKey(poolState.config);
  const config = (await (program.account as any).poolConfig.fetch(
    configPublicKey
  )) as any;

  const baseMint = new PublicKey(poolState.baseMint);
  const quoteMint = new PublicKey(config.quoteMint);
  const baseDecimals = toNumber(config.tokenDecimal);
  const quoteDecimals = await getQuoteDecimals(connection, quoteMint);
  const amountRaw = amountToRaw(
    amount,
    options.partialFill ? quoteDecimals : baseDecimals,
    options.rawAmounts
  );

  if (amountRaw.isZero()) {
    throw new Error("buy amount must be greater than zero");
  }

  const currentPoint = await getCurrentPoint(
    connection,
    toNumber(config.activationType)
  );
  const feeMode = getFeeMode(
    toNumber(config.collectFeeMode),
    TradeDirection.QuoteToBase,
    options.referralTokenAccount != null
  );
  const minimumBaseAmountOut = options.minimumBaseAmountOut
    ? amountToRaw(
        options.minimumBaseAmountOut,
        baseDecimals,
        options.rawAmounts
      )
    : new BN(0);
  const swapQuote = options.partialFill
    ? getSwapResultFromPartialInput(
        poolState,
        config,
        amountRaw,
        feeMode,
        TradeDirection.QuoteToBase,
        currentPoint,
        false
      )
    : getSwapResultFromExactOutput(
        poolState,
        config,
        amountRaw,
        feeMode,
        TradeDirection.QuoteToBase,
        currentPoint,
        false
      );
  const baseAmountRaw = options.partialFill
    ? toBN((swapQuote as any).outputAmount)
    : amountRaw;
  const quoteAmountRaw = toBN((swapQuote as any).includedFeeInputAmount);

  if (options.partialFill && baseAmountRaw.lt(minimumBaseAmountOut)) {
    throw new Error(
      `Partial fill output ${baseAmountRaw.toString()} is below minimum ${minimumBaseAmountOut.toString()}`
    );
  }

  const tokenBaseProgram =
    toNumber(config.tokenType) === TokenType.Token2022
      ? TOKEN_2022_PROGRAM_ID
      : TOKEN_PROGRAM_ID;
  const tokenQuoteProgram = getTokenProgramForFlag(
    toNumber(config.quoteTokenFlag ?? 0)
  );
  const inputTokenAccount = getAssociatedTokenAddressSync(
    quoteMint,
    payer.publicKey,
    true,
    tokenQuoteProgram
  );
  const outputTokenAccount = getAssociatedTokenAddressSync(
    baseMint,
    payer.publicKey,
    true,
    tokenBaseProgram
  );
  const preInstructions = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
    createAssociatedTokenAccountIdempotentInstruction(
      payer.publicKey,
      inputTokenAccount,
      payer.publicKey,
      quoteMint,
      tokenQuoteProgram
    ),
    createAssociatedTokenAccountIdempotentInstruction(
      payer.publicKey,
      outputTokenAccount,
      payer.publicKey,
      baseMint,
      tokenBaseProgram
    ),
  ];
  const postInstructions = [];

  if (quoteMint.equals(NATIVE_MINT)) {
    preInstructions.push(
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: inputTokenAccount,
        lamports: BigInt(quoteAmountRaw.toString()),
      }),
      createSyncNativeInstruction(inputTokenAccount)
    );
    postInstructions.push(
      createCloseAccountInstruction(
        inputTokenAccount,
        payer.publicKey,
        payer.publicKey,
        [],
        TOKEN_PROGRAM_ID
      )
    );
  }

  const transaction = await program.methods
    .swap2({
      amount0: options.partialFill ? amountRaw : baseAmountRaw,
      amount1: options.partialFill ? minimumBaseAmountOut : quoteAmountRaw,
      swapMode: options.partialFill ? 1 : 2,
    })
    .accountsPartial({
      poolAuthority: deriveDbcPoolAuthority(programId),
      config: configPublicKey,
      pool: poolPublicKey,
      inputTokenAccount,
      outputTokenAccount,
      baseVault: new PublicKey(poolState.baseVault),
      quoteVault: new PublicKey(poolState.quoteVault),
      baseMint,
      quoteMint,
      payer: payer.publicKey,
      tokenBaseProgram,
      tokenQuoteProgram,
      referralTokenAccount: options.referralTokenAccount ?? null,
    })
    .remainingAccounts([
      {
        isSigner: false,
        isWritable: false,
        pubkey: SYSVAR_INSTRUCTIONS_PUBKEY,
      },
    ])
    .preInstructions(preInstructions)
    .postInstructions(postInstructions)
    .transaction();

  const signature = await simulateAndSend(connection, transaction, [payer]);

  return {
    pool: poolPublicKey,
    baseAmount: baseAmountRaw.toString(),
    quoteAmount: quoteAmountRaw.toString(),
    inputTokenAccount,
    outputTokenAccount,
    signature,
  };
}
