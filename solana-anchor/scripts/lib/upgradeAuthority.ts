import { PublicKey, TransactionInstruction } from '@solana/web3.js';

const LOADER = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');

export function mustBurnUpgradeAuthority(cluster: string, program: string): boolean {
  return cluster === 'mainnet' || ['zkVerifier', 'verifier', 'implementation'].includes(program);
}

export type ProgramUpgradeStatus = {
  status: 'missing' | 'upgradeable' | 'immutable' | 'foreign';
  authority?: PublicKey;
};

/** A completed deployment must prove who controls each program, including immutable-only ones. */
export function assertUpgradeAuthority(
  label: string,
  live: ProgramUpgradeStatus,
  target: PublicKey,
  mustBeImmutable: boolean,
): void {
  if (live.status === 'immutable') return;
  if (!mustBeImmutable && live.status === 'upgradeable' && live.authority?.equals(target)) return;
  throw new Error(`${label}: unsafe upgrade authority (${live.status}, ${live.authority?.toBase58() ?? 'unknown'}); expected ${mustBeImmutable ? 'immutable' : `immutable or ${target.toBase58()}`}`);
}

/** Transfer to a configured authority, including a Squads PDA (which cannot sign this handoff). */
export function transferUpgradeAuthority(
  program: PublicKey,
  current: PublicKey,
  deployer: PublicKey,
  target: PublicKey,
): TransactionInstruction | null {
  if (current.equals(target)) return null;
  if (!current.equals(deployer)) {
    throw new Error(`policy program: upgrade authority is ${current.toBase58()}, expected ${target.toBase58()}; the current authority must transfer it`);
  }
  const [programData] = PublicKey.findProgramAddressSync([program.toBuffer()], LOADER);
  return new TransactionInstruction({
    programId: LOADER,
    keys: [
      { pubkey: programData, isSigner: false, isWritable: true },
      { pubkey: deployer, isSigner: true, isWritable: false },
      { pubkey: target, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([4, 0, 0, 0]), // UpgradeableLoaderInstruction::SetAuthority
  });
}
