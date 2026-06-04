import {
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  getAssociatedTokenAddressSync,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import {
  buildClient,
  deriveDbcPoolAuthority,
  getTokenProgramForFlag,
  loadKeypair,
  simulateAndSend,
  toNumber,
  unwrapVirtualPoolAccount,
  type WithdrawPartnerMigrationFeeOptions,
  type WithdrawPartnerMigrationFeeResult,
} from "../shared";

export async function withdrawPartnerMigrationFee(
  pool: PublicKey | string,
  options: WithdrawPartnerMigrationFeeOptions = {}
): Promise<WithdrawPartnerMigrationFeeResult> {
  const { connection, program, programId } = await buildClient(options.rpcUrl);
  const feeClaimer = options.feeClaimer ?? loadKeypair();
  const poolPublicKey = typeof pool === "string" ? new PublicKey(pool) : pool;
  const poolState = unwrapVirtualPoolAccount(
    await (program.account as any).virtualPool.fetch(poolPublicKey)
  );
  const configPublicKey = new PublicKey(poolState.config);
  const config = (await (program.account as any).poolConfig.fetch(
    configPublicKey
  )) as any;
  const quoteMint = new PublicKey(config.quoteMint);
  const tokenQuoteProgram = getTokenProgramForFlag(
    toNumber(config.quoteTokenFlag ?? 0)
  );
  const migrationFeeReceiver =
    options.migrationFeeReceiver ?? new PublicKey(config.leftoverReceiver);
  const tokenQuoteAccount = getAssociatedTokenAddressSync(
    quoteMint,
    migrationFeeReceiver,
    true,
    tokenQuoteProgram
  );
  const preInstructions = [
    createAssociatedTokenAccountIdempotentInstruction(
      feeClaimer.publicKey,
      tokenQuoteAccount,
      migrationFeeReceiver,
      quoteMint,
      tokenQuoteProgram
    ),
  ];
  const postInstructions =
    quoteMint.equals(NATIVE_MINT) &&
    migrationFeeReceiver.equals(feeClaimer.publicKey)
      ? [
          createCloseAccountInstruction(
            tokenQuoteAccount,
            feeClaimer.publicKey,
            feeClaimer.publicKey,
            [],
            TOKEN_PROGRAM_ID
          ),
        ]
      : [];

  const transaction = await program.methods
    .withdrawMigrationFee(0)
    .accountsPartial({
      poolAuthority: deriveDbcPoolAuthority(programId),
      config: configPublicKey,
      virtualPool: poolPublicKey,
      tokenQuoteAccount,
      quoteVault: new PublicKey(poolState.quoteVault),
      quoteMint,
      sender: feeClaimer.publicKey,
      tokenQuoteProgram,
    })
    .preInstructions(preInstructions)
    .postInstructions(postInstructions)
    .transaction();

  const signature = await simulateAndSend(connection, transaction, [
    feeClaimer,
  ]);

  return {
    pool: poolPublicKey,
    feeClaimer: feeClaimer.publicKey,
    migrationFeeReceiver,
    tokenQuoteAccount,
    signature,
  };
}
