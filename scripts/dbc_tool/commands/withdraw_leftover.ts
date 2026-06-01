import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
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
  type WithdrawLeftoverOptions,
  type WithdrawLeftoverResult,
} from "../shared";

export async function withdrawLeftover(
  pool: PublicKey | string,
  options: WithdrawLeftoverOptions = {}
): Promise<WithdrawLeftoverResult> {
  const { connection, program, programId } = await buildClient(options.rpcUrl);
  const payer = options.payer ?? loadKeypair();
  const poolPublicKey = typeof pool === "string" ? new PublicKey(pool) : pool;
  const poolState = unwrapVirtualPoolAccount(
    await (program.account as any).virtualPool.fetch(poolPublicKey)
  );
  const configPublicKey = new PublicKey(poolState.config);
  const config = (await (program.account as any).poolConfig.fetch(
    configPublicKey
  )) as any;
  const baseMint = new PublicKey(poolState.baseMint);
  const leftoverReceiver = new PublicKey(config.leftoverReceiver);
  const tokenBaseProgram = getTokenProgramForFlag(toNumber(config.tokenType));
  const tokenBaseAccount = getAssociatedTokenAddressSync(
    baseMint,
    leftoverReceiver,
    true,
    tokenBaseProgram
  );

  const transaction = await program.methods
    .withdrawLeftover()
    .accountsPartial({
      poolAuthority: deriveDbcPoolAuthority(programId),
      config: configPublicKey,
      virtualPool: poolPublicKey,
      tokenBaseAccount,
      baseVault: new PublicKey(poolState.baseVault),
      baseMint,
      leftoverReceiver,
      tokenBaseProgram,
    })
    .preInstructions([
      createAssociatedTokenAccountIdempotentInstruction(
        payer.publicKey,
        tokenBaseAccount,
        leftoverReceiver,
        baseMint,
        tokenBaseProgram
      ),
    ])
    .transaction();

  const signature = await simulateAndSend(connection, transaction, [payer]);

  return {
    pool: poolPublicKey,
    leftoverReceiver,
    tokenBaseAccount,
    signature,
  };
}
