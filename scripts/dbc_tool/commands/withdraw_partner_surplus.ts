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
  type WithdrawPartnerSurplusOptions,
  type WithdrawPartnerSurplusResult,
} from "../shared";

export async function withdrawPartnerSurplus(
  pool: PublicKey | string,
  options: WithdrawPartnerSurplusOptions = {}
): Promise<WithdrawPartnerSurplusResult> {
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
  const surplusReceiver = options.surplusReceiver ?? feeClaimer.publicKey;
  const tokenQuoteAccount = getAssociatedTokenAddressSync(
    quoteMint,
    surplusReceiver,
    true,
    tokenQuoteProgram
  );
  const preInstructions = [
    createAssociatedTokenAccountIdempotentInstruction(
      feeClaimer.publicKey,
      tokenQuoteAccount,
      surplusReceiver,
      quoteMint,
      tokenQuoteProgram
    ),
  ];
  const postInstructions =
    quoteMint.equals(NATIVE_MINT) &&
    surplusReceiver.equals(feeClaimer.publicKey)
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
    .partnerWithdrawSurplus()
    .accountsPartial({
      poolAuthority: deriveDbcPoolAuthority(programId),
      config: configPublicKey,
      virtualPool: poolPublicKey,
      tokenQuoteAccount,
      quoteVault: new PublicKey(poolState.quoteVault),
      quoteMint,
      feeClaimer: feeClaimer.publicKey,
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
    surplusReceiver,
    tokenQuoteAccount,
    signature,
  };
}
