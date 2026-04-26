import {
  DAMM_V2_PROGRAM_ID,
  deriveDammV2EventAuthority,
  deriveDammV2PoolAddress,
  deriveDammV2PoolAuthority,
  deriveDammV2TokenVaultAddress,
  derivePositionAddress,
  derivePositionNftAccount,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import {
  KeeperOptions,
  KeeperResult,
  MigrationProgress,
  buildClient,
  deriveDammV2MigrationMetadata,
  deriveDbcPoolAuthority,
  getTokenProgramForFlag,
  loadKeypair,
  logEvent,
  migrationProgressLabel,
  publicKeyResultToBase58,
  signSendAndConfirm,
} from "./shared";

export async function runKeeper(options: KeeperOptions): Promise<KeeperResult> {
  const { connection, program, programId, rpcUrl } = buildClient(
    options.rpcUrl,
    options.dbcProgramId
  );
  const payer = loadKeypair(options.keypairPath);
  const pool = options.pool;
  const dammConfig = options.dammConfig;

  logEvent({
    event: "keeper_started",
    pool: pool.toBase58(),
    dammConfig: dammConfig.toBase58(),
    dbcProgramId: programId.toBase58(),
    rpcUrl,
    payer: payer.publicKey.toBase58(),
  });

  let subscriptionId: number | undefined;
  let inFlight = false;
  let settled = false;
  let lastLoggedProgress: number | undefined;

  const cleanup = async () => {
    if (subscriptionId !== undefined) {
      await connection.removeSlotChangeListener(subscriptionId);
      subscriptionId = undefined;
    }
  };

  const checkSlot = async (slot: number): Promise<KeeperResult | null> => {
    if (inFlight || settled) {
      return null;
    }
    inFlight = true;
    try {
      const poolState = await (
        program.account as any
      ).virtualPool.fetchNullable(pool);
      if (!poolState) {
        throw new Error(`Pool not found: ${pool.toBase58()}`);
      }

      const progress = Number(poolState.migrationProgress);
      const progressLabel = migrationProgressLabel(progress);
      if (lastLoggedProgress !== progress) {
        logEvent({
          event: "pool_state",
          slot,
          pool: pool.toBase58(),
          migrationProgress: progress,
          migrationProgressLabel: progressLabel,
          action: actionForProgress(progress),
        });
        lastLoggedProgress = progress;
      }

      if (progress === MigrationProgress.CreatedPool) {
        return {
          action: "already_migrated",
          pool,
          config: new PublicKey(poolState.config),
          dammConfig,
        };
      }

      if (progress !== MigrationProgress.LockedVesting) {
        return null;
      }

      logEvent({
        event: "migration_attempt",
        slot,
        pool: pool.toBase58(),
        dammConfig: dammConfig.toBase58(),
      });

      try {
        return await executeDammV2Migration({
          program,
          programId,
          connection,
          payer,
          pool,
          poolState,
          dammConfig,
        });
      } catch (error) {
        const refetchedPoolState = await (
          program.account as any
        ).virtualPool.fetchNullable(pool);
        if (
          refetchedPoolState &&
          Number(refetchedPoolState.migrationProgress) ===
            MigrationProgress.CreatedPool
        ) {
          logEvent({
            event: "migration_race_resolved",
            slot,
            pool: pool.toBase58(),
            action: "externally_migrated",
          });
          return {
            action: "externally_migrated",
            pool,
            config: new PublicKey(refetchedPoolState.config),
            dammConfig,
          };
        }
        throw error;
      }
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

    try {
      subscriptionId = connection.onSlotChange((slotInfo) => {
        checkSlot(slotInfo.slot)
          .then((result) => settle(result))
          .catch((error) => settle(null, error));
      });
      connection
        .getSlot()
        .then((slot) => checkSlot(slot))
        .then((result) => settle(result))
        .catch((error) => settle(null, error));
    } catch (error) {
      settle(null, error);
    }
  });
}

async function executeDammV2Migration(params: {
  program: any;
  programId: PublicKey;
  connection: any;
  payer: Keypair;
  pool: PublicKey;
  poolState: any;
  dammConfig: PublicKey;
}): Promise<KeeperResult> {
  const { program, programId, connection, payer, pool, poolState, dammConfig } =
    params;
  const configPublicKey = new PublicKey(poolState.config);
  const config = await (program.account as any).poolConfig.fetch(
    configPublicKey
  );
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

  const signature = await signSendAndConfirm(connection, transaction, [
    payer,
    firstPositionNftMint,
    secondPositionNftMint,
  ]);

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

function actionForProgress(progress: number): string {
  switch (progress) {
    case MigrationProgress.PreBondingCurve:
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
