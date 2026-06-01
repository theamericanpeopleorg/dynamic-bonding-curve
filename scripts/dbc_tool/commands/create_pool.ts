import {
  METAPLEX_PROGRAM_ID,
  TokenType,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import BN from "bn.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  buildClient,
  getTokenProgramForFlag,
  loadKeypair,
  deriveDbcPoolAddressForProgram,
  deriveDbcPoolAuthority,
  deriveDbcTokenVaultAddress,
  deriveMintMetadata,
  simulateAndSend,
  type CreatePoolOptions,
  type CreatePoolResult,
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
    symbol: options.symbol ?? "VOT",
    uri: options.uri ?? "https://example.com/localnet-dbc-token.json",
    deadlineTimestamp: new BN(String(options.deadlineTimestamp ?? 0)),
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
