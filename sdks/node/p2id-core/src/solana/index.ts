// @pvium/p2id-core/solana: P2ID on Solana. Same identities and commitments as the root export;
// addresses are program-derived addresses of the router program, as base58 strings. No
// @solana/web3.js dependency: pass the results to whichever client you use.
export {
  SOLANA_SEEDS, FACTORY_PARAMS_PREFIX, CONSTRAINT_PREFIX, ALPHA_PREFIX, ALPHA_ACTION,
  SYSTEM_PROGRAM_ID, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, INSTRUCTIONS_SYSVAR_ID,
  solanaPrograms, solanaFactory, factoryParamsHash, factoryAddress, policyAddress, policyMintAddress,
  verifierConfigAddress, implAuthorityAddress,
  p2idAddress, p2idAddressForHash, depositAddress, vaultMintAddress, associatedTokenAddress,
  p2idFundingVerifier, p2idVerifier, fundAccounts, constraintMessage, alphaApprovalMessage,
  toBase58, fromBase58,
} from './address.js';
export type { SolanaSchemeOptions, SolanaEnvironmentOptions, P2IDSolanaAddressInput, FundInput, FundSolAccounts, FundTokenAccounts } from './address.js';
export { findProgramAddress, createProgramAddress, isOnCurve } from './pda.js';
export type { Pubkey } from './pda.js';
export { identityHash, p2idScheme, P2ID_SCHEME, P2ID_SCHEMES } from '../scheme.js';
export type { P2IDEnvironment, P2IDScheme, P2IDSchemeName, P2IDSolanaScheme, P2IDSolanaFactory, P2IDSolanaFactoryParams, P2IDSolanaVerifier } from '../scheme.js';
export { IdentityType } from '../identity.js';
export type { IdentityTypeName } from '../identityNames.js';
