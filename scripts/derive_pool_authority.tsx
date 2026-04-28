import { PublicKey } from "@solana/web3.js";

const DEFAULT_DBC_PROGRAM_ID = "BGYDrwDnJVuYkHewahreyiddfMXErUDzp3RvVEDPmYBz";

function usage(): void {
  console.error(
    "Usage: pnpm exec tsx scripts/derive_pool_authority.tsx [DBC_PROGRAM_ID]"
  );
}

function main(): void {
  const programIdArg = process.argv[2] ?? DEFAULT_DBC_PROGRAM_ID;

  let programId: PublicKey;
  try {
    programId = new PublicKey(programIdArg);
  } catch {
    usage();
    throw new Error(`Invalid DBC program id: ${programIdArg}`);
  }

  const [poolAuthority, bump] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool_authority")],
    programId
  );

  console.log(
    JSON.stringify(
      {
        programId: programId.toBase58(),
        seed: "pool_authority",
        poolAuthority: poolAuthority.toBase58(),
        bump,
      },
      null,
      2
    )
  );
}

main();
