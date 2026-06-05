import {
  DAMM_V2_PROGRAM_ID,
  deriveDammV2EventAuthority,
  deriveDammV2PoolAddress,
  deriveDammV2PoolAuthority,
  deriveDammV2TokenVaultAddress,
  derivePositionAddress,
  derivePositionNftAccount,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  getAssociatedTokenAddressSync,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import {
  KeeperOptions,
  KeeperResult,
  DEFAULT_STATUS_INTERVAL_MS,
  MigrationProgress,
  buildClient,
  deriveDammV2MigrationMetadata,
  deriveDbcPoolAuthority,
  errorMessage,
  getQuoteDecimals,
  getTokenProgramForFlag,
  isRetryableRpcError,
  loadKeypair,
  logEvent,
  migrationProgressLabel,
  percent,
  publicKeyResultToBase58,
  rawAmountToUi,
  retryRpc,
  RpcRetryLogger,
  signSendAndConfirm,
  toBigInt,
  unwrapVirtualPoolAccount,
} from "./shared";

const MIGRATION_TRANSPORT_ATTEMPTS = 3;
const MIGRATION_TRANSPORT_RETRY_DELAY_MS = 2_000;

export async function runKeeper(options: KeeperOptions): Promise<KeeperResult> {
  const { connection, program, programId, rpcUrl } = buildClient(
    options.rpcUrl,
    options.dbcProgramId
  );
  const payer = loadKeypair(options.keypairPath);
  const pool = options.pool;
  const dammConfig = options.dammConfig;
  const statusIntervalMs =
    options.statusIntervalMs ?? DEFAULT_STATUS_INTERVAL_MS;

  logEvent({
    event: "keeper_started",
    pool: pool.toBase58(),
    dammConfig: dammConfig.toBase58(),
    dbcProgramId: programId.toBase58(),
    rpcUrl,
    payer: payer.publicKey.toBase58(),
    statusIntervalMs,
  });

  let pollIntervalId: ReturnType<typeof setInterval> | undefined;
  let inFlight = false;
  let settled = false;
  let lastLoggedProgress: number | undefined;
  let lastStatusLoggedAtMs = 0;
  let saleProgressConfig: SaleProgressConfig | undefined;

  const cleanup = async () => {
    if (pollIntervalId !== undefined) {
      clearInterval(pollIntervalId);
      pollIntervalId = undefined;
    }
  };

  const checkSlot = async (slot: number): Promise<KeeperResult | null> => {
    if (inFlight || settled) {
      return null;
    }
    inFlight = true;
    try {
      const onRetry = createRpcRetryLogger(pool, slot);
      const poolState = await fetchPoolState({
        program,
        pool,
        operation: "fetchVirtualPool",
        onRetry,
      });
      if (!poolState) {
        throw new Error(`Pool not found: ${pool.toBase58()}`);
      }

      const saleProgress = await getSaleProgressLogFields({
        connection,
        program,
        poolState,
        saleProgressConfig,
        onRetry,
        slot,
      });
      saleProgressConfig = saleProgress.config;
      const progress = Number(poolState.migrationProgress);
      const progressLabel = migrationProgressLabel(progress);
      const action = actionForProgress(progress, saleProgress);
      if (lastLoggedProgress !== progress) {
        logEvent({
          event: "pool_state",
          slot,
          pool: pool.toBase58(),
          migrationProgress: progress,
          migrationProgressLabel: progressLabel,
          action,
          ...saleProgress.logFields,
        });
        lastLoggedProgress = progress;
        lastStatusLoggedAtMs = Date.now();
      } else {
        const now = Date.now();
        if (now - lastStatusLoggedAtMs >= statusIntervalMs) {
          logEvent({
            event: "keeper_status",
            slot,
            pool: pool.toBase58(),
            migrationProgress: progress,
            migrationProgressLabel: progressLabel,
            action,
            ...saleProgress.logFields,
          });
          lastStatusLoggedAtMs = now;
        }
      }

      if (progress === MigrationProgress.CreatedPool) {
        return await withLeftoverWithdrawal({
          program,
          programId,
          connection,
          payer,
          pool,
          dammConfig,
          slot,
          onRetry,
          withdrawLeftover: options.withdrawLeftover === true,
          surplusReceiver: options.surplusReceiver,
          result: {
            action: "already_migrated",
            pool,
            config: new PublicKey(poolState.config),
            dammConfig,
          },
        });
      }

      const shouldAttemptMigration =
        progress === MigrationProgress.LockedVesting ||
        (progress === MigrationProgress.PreBondingCurve &&
          saleProgress.logFields.completionMode === "deadline" &&
          !saleProgress.config.hasLockedVesting);

      if (!shouldAttemptMigration) {
        return null;
      }

      logEvent({
        event: "migration_attempt",
        slot,
        pool: pool.toBase58(),
        dammConfig: dammConfig.toBase58(),
      });

      const result = await executeDammV2MigrationWithTransportRetries({
        program,
        programId,
        connection,
        payer,
        pool,
        poolState,
        dammConfig,
        slot,
      });
      return await withLeftoverWithdrawal({
        program,
        programId,
        connection,
        payer,
        pool,
        dammConfig,
        slot,
        onRetry,
        withdrawLeftover: options.withdrawLeftover === true,
        surplusReceiver: options.surplusReceiver,
        result,
      });
    } catch (error) {
      if (isRetryableRpcError(error)) {
        logEvent({
          event: "rpc_unavailable",
          slot,
          pool: pool.toBase58(),
          message: errorMessage(error),
        });
        return null;
      }
      throw error;
    } finally {
      inFlight = false;
    }
  };

  return new Promise<KeeperResult>((resolve, reject) => {
    const settle = async (result: KeeperResult | null, error?: unknown) => {
      if (settled || (!result && !error)) {
        return;
      }
      settled = true;
      await cleanup();
      if (error) {
        logEvent({
          event: "keeper_error",
          pool: pool.toBase58(),
          message: error instanceof Error ? error.message : String(error),
        });
        reject(error);
        return;
      }

      logEvent({
        event: "keeper_done",
        ...publicKeyResultToBase58(
          result as unknown as Record<string, unknown>
        ),
      });
      resolve(result as KeeperResult);
    };

    const handleCheckError = (error: unknown, slot?: number) => {
      if (isRetryableRpcError(error)) {
        logEvent({
          event: "rpc_unavailable",
          pool: pool.toBase58(),
          slot,
          message: errorMessage(error),
        });
        return;
      }
      settle(null, error);
    };

    const runCheckForCurrentSlot = (operation: string) => {
      retryRpc({
        operation,
        fn: () => connection.getSlot(),
        onRetry: createRpcRetryLogger(pool),
      })
        .then((slot) =>
          checkSlot(slot)
            .then((result) => settle(result))
            .catch((error) => handleCheckError(error, slot))
        )
        .catch((error) => handleCheckError(error));
    };

    try {
      pollIntervalId = setInterval(() => {
        runCheckForCurrentSlot("pollGetSlot");
      }, statusIntervalMs);
      runCheckForCurrentSlot("initialGetSlot");
    } catch (error) {
      settle(null, error);
    }
  });
}

type SaleProgressConfig = {
  config: PublicKey;
  migrationQuoteThreshold: bigint;
  migrationQuoteAmountCap: bigint;
  hasLockedVesting: boolean;
  quoteDecimals: number;
};

async function getSaleProgressLogFields(params: {
  connection: any;
  program: any;
  poolState: any;
  saleProgressConfig?: SaleProgressConfig;
  onRetry?: RpcRetryLogger;
  slot?: number;
}): Promise<{
  config: SaleProgressConfig;
  logFields: Record<string, string | boolean | null>;
}> {
  const configPublicKey = new PublicKey(params.poolState.config);
  let saleProgressConfig = params.saleProgressConfig;

  if (
    !saleProgressConfig ||
    !saleProgressConfig.config.equals(configPublicKey)
  ) {
    const config = (await retryRpc({
      operation: "fetchPoolConfigForSaleProgress",
      fn: () =>
        (params.program.account as any).poolConfig.fetch(configPublicKey),
      onRetry: params.onRetry,
    })) as any;
    const quoteMint = new PublicKey(config.quoteMint);
    saleProgressConfig = {
      config: configPublicKey,
      migrationQuoteThreshold: toBigInt(config.migrationQuoteThreshold),
      migrationQuoteAmountCap:
        toBigInt(config.migrationQuoteAmountCap ?? 0) === BigInt(0)
          ? toBigInt(config.migrationQuoteThreshold)
          : toBigInt(config.migrationQuoteAmountCap),
      hasLockedVesting: hasLockedVesting(config),
      quoteDecimals: await retryRpc({
        operation: "fetchQuoteDecimalsForSaleProgress",
        fn: () => getQuoteDecimals(params.connection, quoteMint),
        onRetry: params.onRetry,
      }),
    };
  }

  const quoteReserve = toBigInt(params.poolState.quoteReserve);
  const virtualQuoteReserve = toBigInt(
    params.poolState.virtualQuoteReserve ?? 0
  );
  const totalQuoteReserve = quoteReserve + virtualQuoteReserve;
  const deadlineTimestamp = toBigInt(params.poolState.deadlineTimestamp ?? 0);
  const blockTime =
    params.slot === undefined
      ? null
      : await retryRpc({
          operation: "getBlockTimeForSaleProgress",
          fn: () => params.connection.getBlockTime(params.slot),
          onRetry: params.onRetry,
        });
  const currentTimestamp = BigInt(
    (blockTime as number | null) ?? Math.floor(Date.now() / 1000)
  );
  const thresholdReached =
    totalQuoteReserve >= saleProgressConfig.migrationQuoteThreshold;
  const deadlineReached =
    deadlineTimestamp !== BigInt(0) && currentTimestamp >= deadlineTimestamp;
  const saleComplete = thresholdReached || deadlineReached;
  const completionMode = thresholdReached
    ? "threshold"
    : deadlineReached
    ? "deadline"
    : "open";
  const quoteRemaining = thresholdReached
    ? BigInt(0)
    : saleProgressConfig.migrationQuoteThreshold - totalQuoteReserve;
  const completedQuote =
    totalQuoteReserve > saleProgressConfig.migrationQuoteThreshold
      ? saleProgressConfig.migrationQuoteThreshold
      : totalQuoteReserve;

  return {
    config: saleProgressConfig,
    logFields: {
      saleCompletionPercent: percent(
        completedQuote,
        saleProgressConfig.migrationQuoteThreshold
      ),
      quoteReserveRaw: quoteReserve.toString(),
      quoteReserveUi: rawAmountToUi(
        quoteReserve,
        saleProgressConfig.quoteDecimals
      ),
      virtualQuoteReserveRaw: virtualQuoteReserve.toString(),
      virtualQuoteReserveUi: rawAmountToUi(
        virtualQuoteReserve,
        saleProgressConfig.quoteDecimals
      ),
      totalQuoteReserveRaw: totalQuoteReserve.toString(),
      totalQuoteReserveUi: rawAmountToUi(
        totalQuoteReserve,
        saleProgressConfig.quoteDecimals
      ),
      migrationQuoteThresholdRaw:
        saleProgressConfig.migrationQuoteThreshold.toString(),
      migrationQuoteThresholdUi: rawAmountToUi(
        saleProgressConfig.migrationQuoteThreshold,
        saleProgressConfig.quoteDecimals
      ),
      migrationQuoteAmountCapRaw:
        saleProgressConfig.migrationQuoteAmountCap.toString(),
      migrationQuoteAmountCapUi: rawAmountToUi(
        saleProgressConfig.migrationQuoteAmountCap,
        saleProgressConfig.quoteDecimals
      ),
      deadlineTimestampRaw: deadlineTimestamp.toString(),
      deadlineReached,
      saleComplete,
      completionMode,
      quoteRemainingRaw: quoteRemaining.toString(),
      quoteRemainingUi: rawAmountToUi(
        quoteRemaining,
        saleProgressConfig.quoteDecimals
      ),
    },
  };
}

function hasLockedVesting(config: any): boolean {
  const lockedVestingConfig = config.lockedVestingConfig;
  if (!lockedVestingConfig) {
    return false;
  }

  return [
    lockedVestingConfig.amountPerPeriod,
    lockedVestingConfig.cliffDurationFromMigrationTime,
    lockedVestingConfig.frequency,
    lockedVestingConfig.numberOfPeriod,
    lockedVestingConfig.cliffUnlockAmount,
  ].some((value) => toBigInt(value ?? 0) !== BigInt(0));
}

async function executeDammV2MigrationWithTransportRetries(params: {
  program: any;
  programId: PublicKey;
  connection: any;
  payer: Keypair;
  pool: PublicKey;
  poolState: any;
  dammConfig: PublicKey;
  slot: number;
}): Promise<KeeperResult | null> {
  let poolState = params.poolState;
  const onRetry = createRpcRetryLogger(params.pool, params.slot);

  for (let attempt = 1; attempt <= MIGRATION_TRANSPORT_ATTEMPTS; attempt++) {
    try {
      return await executeDammV2Migration({
        ...params,
        poolState,
        onRetry,
      });
    } catch (error) {
      const migrated = await fetchCreatedPoolResultAfterMigrationError({
        program: params.program,
        pool: params.pool,
        dammConfig: params.dammConfig,
        slot: params.slot,
        onRetry,
        originalError: error,
      });
      if (migrated) {
        return migrated;
      }

      if (!isRetryableRpcError(error)) {
        throw error;
      }

      if (attempt === MIGRATION_TRANSPORT_ATTEMPTS) {
        logEvent({
          event: "migration_retry_exhausted",
          slot: params.slot,
          pool: params.pool.toBase58(),
          attempt,
          maxAttempts: MIGRATION_TRANSPORT_ATTEMPTS,
          message: errorMessage(error),
        });
        return null;
      }

      logEvent({
        event: "migration_retry",
        slot: params.slot,
        pool: params.pool.toBase58(),
        attempt,
        maxAttempts: MIGRATION_TRANSPORT_ATTEMPTS,
        nextDelayMs: MIGRATION_TRANSPORT_RETRY_DELAY_MS,
        message: errorMessage(error),
      });
      await delay(MIGRATION_TRANSPORT_RETRY_DELAY_MS);

      const refetchedPoolState = await fetchPoolState({
        program: params.program,
        pool: params.pool,
        operation: "refetchVirtualPoolBeforeMigrationRetry",
        onRetry,
      });
      if (!refetchedPoolState) {
        throw new Error(`Pool not found: ${params.pool.toBase58()}`);
      }
      if (
        Number(refetchedPoolState.migrationProgress) ===
        MigrationProgress.CreatedPool
      ) {
        return externallyMigratedResult({
          slot: params.slot,
          pool: params.pool,
          poolState: refetchedPoolState,
          dammConfig: params.dammConfig,
        });
      }
      if (
        Number(refetchedPoolState.migrationProgress) !==
        MigrationProgress.LockedVesting
      ) {
        return null;
      }
      poolState = refetchedPoolState;
    }
  }

  return null;
}

async function fetchCreatedPoolResultAfterMigrationError(params: {
  program: any;
  pool: PublicKey;
  dammConfig: PublicKey;
  slot: number;
  onRetry: RpcRetryLogger;
  originalError: unknown;
}): Promise<KeeperResult | null> {
  try {
    const refetchedPoolState = await fetchPoolState({
      program: params.program,
      pool: params.pool,
      operation: "refetchVirtualPoolAfterMigrationError",
      onRetry: params.onRetry,
    });
    if (
      refetchedPoolState &&
      Number(refetchedPoolState.migrationProgress) ===
        MigrationProgress.CreatedPool
    ) {
      return externallyMigratedResult({
        slot: params.slot,
        pool: params.pool,
        poolState: refetchedPoolState,
        dammConfig: params.dammConfig,
      });
    }

    return null;
  } catch (refetchError) {
    if (isRetryableRpcError(params.originalError)) {
      logEvent({
        event: "migration_refetch_failed",
        slot: params.slot,
        pool: params.pool.toBase58(),
        message: errorMessage(refetchError),
      });
      return null;
    }

    throw params.originalError;
  }
}

async function withLeftoverWithdrawal(params: {
  program: any;
  programId: PublicKey;
  connection: any;
  payer: Keypair;
  pool: PublicKey;
  dammConfig: PublicKey;
  slot: number;
  onRetry: RpcRetryLogger;
  withdrawLeftover: boolean;
  surplusReceiver?: PublicKey;
  result: KeeperResult | null;
}): Promise<KeeperResult | null> {
  if (!params.result) {
    return null;
  }

  const partnerSurplusWithdrawal = await maybeWithdrawPartnerSurplus(params);
  const leftoverWithdrawal = params.withdrawLeftover
    ? await maybeWithdrawLeftover(params)
    : {};
  return {
    ...params.result,
    ...partnerSurplusWithdrawal,
    ...leftoverWithdrawal,
  };
}

async function maybeWithdrawPartnerSurplus(params: {
  program: any;
  programId: PublicKey;
  connection: any;
  payer: Keypair;
  pool: PublicKey;
  slot: number;
  onRetry: RpcRetryLogger;
  surplusReceiver?: PublicKey;
}): Promise<
  Pick<
    KeeperResult,
    | "partnerSurplusWithdrawStatus"
    | "partnerSurplusWithdrawSignature"
    | "partnerFeeClaimer"
    | "surplusReceiver"
    | "partnerQuoteAccount"
    | "partnerSurplusWithdrawError"
  >
> {
  const poolState = await fetchPoolState({
    program: params.program,
    pool: params.pool,
    operation: "fetchVirtualPoolBeforeWithdrawPartnerSurplus",
    onRetry: params.onRetry,
  });
  if (!poolState) {
    throw new Error(`Pool not found: ${params.pool.toBase58()}`);
  }

  const configPublicKey = new PublicKey(poolState.config);
  const config = (await retryRpc({
    operation: "fetchPoolConfigBeforeWithdrawPartnerSurplus",
    fn: () => (params.program.account as any).poolConfig.fetch(configPublicKey),
    onRetry: params.onRetry,
  })) as any;
  const feeClaimer = new PublicKey(config.feeClaimer);

  if (!params.payer.publicKey.equals(feeClaimer)) {
    logEvent({
      event: "withdraw_partner_surplus_skipped",
      slot: params.slot,
      pool: params.pool.toBase58(),
      reason: "keeper_not_fee_claimer",
      keeper: params.payer.publicKey.toBase58(),
      feeClaimer: feeClaimer.toBase58(),
    });
    return {
      partnerSurplusWithdrawStatus: "skipped_not_fee_claimer",
      partnerFeeClaimer: feeClaimer,
    };
  }

  const quoteReserve = toBigInt(poolState.quoteReserve);
  const rawMigrationQuoteAmountCap = toBigInt(
    config.migrationQuoteAmountCap ?? 0
  );
  const migrationQuoteAmountCap =
    rawMigrationQuoteAmountCap === BigInt(0)
      ? toBigInt(config.migrationQuoteThreshold)
      : rawMigrationQuoteAmountCap;

  if (quoteReserve <= migrationQuoteAmountCap) {
    logEvent({
      event: "withdraw_partner_surplus_skipped",
      slot: params.slot,
      pool: params.pool.toBase58(),
      reason: "no_surplus",
      feeClaimer: feeClaimer.toBase58(),
      quoteReserveRaw: quoteReserve.toString(),
      migrationQuoteAmountCapRaw: migrationQuoteAmountCap.toString(),
    });
    return {
      partnerSurplusWithdrawStatus: "skipped_no_surplus",
      partnerFeeClaimer: feeClaimer,
    };
  }

  const isPartnerWithdrawSurplus = Number(
    poolState.isPartnerWithdrawSurplus ??
      poolState.is_partner_withdraw_surplus ??
      0
  );
  if (isPartnerWithdrawSurplus !== 0) {
    logEvent({
      event: "withdraw_partner_surplus_skipped",
      slot: params.slot,
      pool: params.pool.toBase58(),
      reason: "already_withdrawn",
      feeClaimer: feeClaimer.toBase58(),
    });
    return {
      partnerSurplusWithdrawStatus: "already_withdrawn",
      partnerFeeClaimer: feeClaimer,
    };
  }

  const quoteMint = new PublicKey(config.quoteMint);
  const tokenQuoteProgram = getTokenProgramForFlag(
    Number(config.quoteTokenFlag ?? 0)
  );
  const surplusReceiver = params.surplusReceiver ?? feeClaimer;
  const tokenQuoteAccount = getAssociatedTokenAddressSync(
    quoteMint,
    surplusReceiver,
    true,
    tokenQuoteProgram
  );

  try {
    const transactionBuilder = params.program.methods
      .partnerWithdrawSurplus()
      .accountsPartial({
        poolAuthority: deriveDbcPoolAuthority(params.programId),
        config: configPublicKey,
        virtualPool: params.pool,
        tokenQuoteAccount,
        quoteVault: new PublicKey(poolState.quoteVault),
        quoteMint,
        feeClaimer,
        tokenQuoteProgram,
      })
      .preInstructions([
        createAssociatedTokenAccountIdempotentInstruction(
          params.payer.publicKey,
          tokenQuoteAccount,
          surplusReceiver,
          quoteMint,
          tokenQuoteProgram
        ),
      ]);

    if (quoteMint.equals(NATIVE_MINT) && surplusReceiver.equals(feeClaimer)) {
      transactionBuilder.postInstructions([
        createCloseAccountInstruction(
          tokenQuoteAccount,
          params.payer.publicKey,
          feeClaimer,
          [],
          TOKEN_PROGRAM_ID
        ),
      ]);
    }

    const transaction = await transactionBuilder.transaction();
    const signature = await signSendAndConfirm(
      params.connection,
      transaction,
      [params.payer],
      params.onRetry
    );

    logEvent({
      event: "withdraw_partner_surplus_done",
      slot: params.slot,
      pool: params.pool.toBase58(),
      feeClaimer: feeClaimer.toBase58(),
      surplusReceiver: surplusReceiver.toBase58(),
      tokenQuoteAccount: tokenQuoteAccount.toBase58(),
      signature,
    });

    return {
      partnerSurplusWithdrawStatus: "withdrawn",
      partnerSurplusWithdrawSignature: signature,
      partnerFeeClaimer: feeClaimer,
      surplusReceiver,
      partnerQuoteAccount: tokenQuoteAccount,
    };
  } catch (error) {
    const message = errorMessage(error);
    logEvent({
      event: "withdraw_partner_surplus_failed",
      slot: params.slot,
      pool: params.pool.toBase58(),
      feeClaimer: feeClaimer.toBase58(),
      surplusReceiver: surplusReceiver.toBase58(),
      tokenQuoteAccount: tokenQuoteAccount.toBase58(),
      message,
    });
    return {
      partnerSurplusWithdrawStatus: "failed",
      partnerFeeClaimer: feeClaimer,
      surplusReceiver,
      partnerQuoteAccount: tokenQuoteAccount,
      partnerSurplusWithdrawError: message,
    };
  }
}

async function maybeWithdrawLeftover(params: {
  program: any;
  programId: PublicKey;
  connection: any;
  payer: Keypair;
  pool: PublicKey;
  slot: number;
  onRetry: RpcRetryLogger;
}): Promise<
  Pick<
    KeeperResult,
    | "leftoverWithdrawStatus"
    | "leftoverWithdrawSignature"
    | "leftoverReceiver"
    | "leftoverBaseAccount"
    | "leftoverWithdrawError"
  >
> {
  const poolState = await fetchPoolState({
    program: params.program,
    pool: params.pool,
    operation: "fetchVirtualPoolBeforeWithdrawLeftover",
    onRetry: params.onRetry,
  });
  if (!poolState) {
    throw new Error(`Pool not found: ${params.pool.toBase58()}`);
  }

  const configPublicKey = new PublicKey(poolState.config);
  const config = (await retryRpc({
    operation: "fetchPoolConfigBeforeWithdrawLeftover",
    fn: () => (params.program.account as any).poolConfig.fetch(configPublicKey),
    onRetry: params.onRetry,
  })) as any;
  const fixedTokenSupplyFlag = Number(config.fixedTokenSupplyFlag ?? 0);
  const isWithdrawLeftover = Number(poolState.isWithdrawLeftover ?? 0);

  if (fixedTokenSupplyFlag !== 1) {
    logEvent({
      event: "withdraw_leftover_skipped",
      slot: params.slot,
      pool: params.pool.toBase58(),
      reason: "non_fixed_supply",
    });
    return {
      leftoverWithdrawStatus: "skipped_non_fixed_supply",
    };
  }

  if (isWithdrawLeftover !== 0) {
    logEvent({
      event: "withdraw_leftover_skipped",
      slot: params.slot,
      pool: params.pool.toBase58(),
      reason: "already_withdrawn",
    });
    return {
      leftoverWithdrawStatus: "already_withdrawn",
    };
  }

  const baseMint = new PublicKey(poolState.baseMint);
  const leftoverReceiver = new PublicKey(config.leftoverReceiver);
  const tokenBaseProgram = getTokenProgramForFlag(Number(config.tokenType));
  const tokenBaseAccount = getAssociatedTokenAddressSync(
    baseMint,
    leftoverReceiver,
    true,
    tokenBaseProgram
  );

  try {
    const transaction = await params.program.methods
      .withdrawLeftover()
      .accountsPartial({
        poolAuthority: deriveDbcPoolAuthority(params.programId),
        config: configPublicKey,
        virtualPool: params.pool,
        tokenBaseAccount,
        baseVault: new PublicKey(poolState.baseVault),
        baseMint,
        leftoverReceiver,
        tokenBaseProgram,
      })
      .preInstructions([
        createAssociatedTokenAccountIdempotentInstruction(
          params.payer.publicKey,
          tokenBaseAccount,
          leftoverReceiver,
          baseMint,
          tokenBaseProgram
        ),
      ])
      .transaction();

    const signature = await signSendAndConfirm(
      params.connection,
      transaction,
      [params.payer],
      params.onRetry
    );

    logEvent({
      event: "withdraw_leftover_done",
      slot: params.slot,
      pool: params.pool.toBase58(),
      leftoverReceiver: leftoverReceiver.toBase58(),
      tokenBaseAccount: tokenBaseAccount.toBase58(),
      signature,
    });

    return {
      leftoverWithdrawStatus: "withdrawn",
      leftoverWithdrawSignature: signature,
      leftoverReceiver,
      leftoverBaseAccount: tokenBaseAccount,
    };
  } catch (error) {
    const message = errorMessage(error);
    logEvent({
      event: "withdraw_leftover_failed",
      slot: params.slot,
      pool: params.pool.toBase58(),
      leftoverReceiver: leftoverReceiver.toBase58(),
      tokenBaseAccount: tokenBaseAccount.toBase58(),
      message,
    });
    return {
      leftoverWithdrawStatus: "failed",
      leftoverReceiver,
      leftoverBaseAccount: tokenBaseAccount,
      leftoverWithdrawError: message,
    };
  }
}

function externallyMigratedResult(params: {
  slot: number;
  pool: PublicKey;
  poolState: any;
  dammConfig: PublicKey;
}): KeeperResult {
  logEvent({
    event: "migration_race_resolved",
    slot: params.slot,
    pool: params.pool.toBase58(),
    action: "externally_migrated",
  });
  return {
    action: "externally_migrated",
    pool: params.pool,
    config: new PublicKey(params.poolState.config),
    dammConfig: params.dammConfig,
  };
}

function fetchPoolState(params: {
  program: any;
  pool: PublicKey;
  operation: string;
  onRetry?: RpcRetryLogger;
}): Promise<any | null> {
  return retryRpc({
    operation: params.operation,
    fn: () =>
      (params.program.account as any).virtualPool.fetchNullable(params.pool),
    onRetry: params.onRetry,
  }).then((account) => (account ? unwrapVirtualPoolAccount(account) : null));
}

function createRpcRetryLogger(pool: PublicKey, slot?: number): RpcRetryLogger {
  return (info) => {
    logEvent({
      event: "rpc_retry",
      pool: pool.toBase58(),
      slot,
      operation: info.operation,
      attempt: info.attempt,
      maxAttempts: info.maxAttempts,
      nextDelayMs: info.nextDelayMs,
      message: info.message,
    });
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function executeDammV2Migration(params: {
  program: any;
  programId: PublicKey;
  connection: any;
  payer: Keypair;
  pool: PublicKey;
  poolState: any;
  dammConfig: PublicKey;
  onRetry: RpcRetryLogger;
}): Promise<KeeperResult> {
  const { program, programId, connection, payer, pool, poolState, dammConfig } =
    params;
  const configPublicKey = new PublicKey(poolState.config);
  const config = (await retryRpc({
    operation: "fetchPoolConfigForMigration",
    fn: () => (program.account as any).poolConfig.fetch(configPublicKey),
    onRetry: params.onRetry,
  })) as any;
  const baseMint = new PublicKey(poolState.baseMint);
  const quoteMint = new PublicKey(config.quoteMint);
  const dammPool = deriveDammV2PoolAddress(dammConfig, baseMint, quoteMint);
  const firstPositionNftMint = Keypair.generate();
  const secondPositionNftMint = Keypair.generate();
  const firstPosition = derivePositionAddress(firstPositionNftMint.publicKey);
  const secondPosition = derivePositionAddress(secondPositionNftMint.publicKey);
  const firstPositionNftAccount = derivePositionNftAccount(
    firstPositionNftMint.publicKey
  );
  const secondPositionNftAccount = derivePositionNftAccount(
    secondPositionNftMint.publicKey
  );
  const tokenBaseProgram = getTokenProgramForFlag(Number(config.tokenType));
  const tokenQuoteProgram = getTokenProgramForFlag(
    Number(config.quoteTokenFlag ?? 0)
  );

  const transaction = await program.methods
    .migrationDammV2()
    .accountsStrict({
      virtualPool: pool,
      migrationMetadata: deriveDammV2MigrationMetadata(pool, programId),
      config: configPublicKey,
      poolAuthority: deriveDbcPoolAuthority(programId),
      pool: dammPool,
      firstPositionNftMint: firstPositionNftMint.publicKey,
      firstPositionNftAccount,
      firstPosition,
      secondPositionNftMint: secondPositionNftMint.publicKey,
      secondPositionNftAccount,
      secondPosition,
      dammPoolAuthority: deriveDammV2PoolAuthority(),
      ammProgram: DAMM_V2_PROGRAM_ID,
      baseMint,
      quoteMint,
      tokenAVault: deriveDammV2TokenVaultAddress(dammPool, baseMint),
      tokenBVault: deriveDammV2TokenVaultAddress(dammPool, quoteMint),
      baseVault: new PublicKey(poolState.baseVault),
      quoteVault: new PublicKey(poolState.quoteVault),
      payer: payer.publicKey,
      tokenBaseProgram,
      tokenQuoteProgram,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      dammEventAuthority: deriveDammV2EventAuthority(),
    })
    .remainingAccounts([
      {
        isSigner: false,
        isWritable: false,
        pubkey: dammConfig,
      },
    ])
    .preInstructions([
      ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }),
    ])
    .transaction();

  const signature = await signSendAndConfirm(
    connection,
    transaction,
    [payer, firstPositionNftMint, secondPositionNftMint],
    params.onRetry
  );

  return {
    action: "migrated",
    pool,
    config: configPublicKey,
    dammConfig,
    dammPool,
    firstPosition,
    secondPosition,
    signature,
  };
}

function actionForProgress(
  progress: number,
  saleProgress?: {
    config: SaleProgressConfig;
    logFields: Record<string, string | boolean | null>;
  }
): string {
  switch (progress) {
    case MigrationProgress.PreBondingCurve:
      if (saleProgress?.logFields.completionMode === "deadline") {
        return saleProgress.config.hasLockedVesting
          ? "locker_needed"
          : "migrate";
      }
      return "watching";
    case MigrationProgress.PostBondingCurve:
      return "locker_needed";
    case MigrationProgress.LockedVesting:
      return "migrate";
    case MigrationProgress.CreatedPool:
      return "already_migrated";
    default:
      return "unknown";
  }
}
