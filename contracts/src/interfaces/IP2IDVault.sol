// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IP2IDVerifier} from "./IP2IDVerifier.sol";

/// @title IP2IDVault
/// @notice Deposit funding, claims, refunds and accounting for one identity commitment.
///         Token address(0) denotes native coin. Each deposit records its verifier and fee rate.
interface IP2IDVault {
    /// @dev Field order packs into 5 storage slots:
    ///      [funder, fundedAt, consumed] [token, refundWindow] [verifier, feeBps] [amount] [constraint].
    struct Deposit {
        address funder;
        uint64 fundedAt;
        bool consumed;
        address token;
        uint64 refundWindow;
        address verifier;
        /// Fee rate fixed when the deposit was made (<= MAX_FEE_BPS); charged only on a claim.
        uint16 feeBps;
        uint128 amount;
        bytes32 constraint;
    }

    // ------------------------------------------------------------------ events
    // Funding emits Funded; consumption emits Refunded or Claimed. Sweeps emit aggregate amounts.

    /// @notice A deposit was recorded via fund()/fundWith()/fundFor().
    /// @param ref Opaque application reference; zero means absent. Emitted only, not stored or enforced as unique.
    event Funded(uint256 indexed depositId, address indexed funder, address indexed token, uint256 amount, address verifier, bytes32 constraint, uint64 refundWindow, uint16 feeBps, bytes32 ref);
    /// @notice An unconsumed deposit was returned to its funder after its refund window (never charged a fee).
    event Refunded(uint256 indexed depositId, address indexed funder, address indexed token, uint256 amount);
    /// @notice A deposit was paid out by a sweep: `amount` gross, of which `fee` accrued as a fee.
    event Claimed(uint256 indexed depositId, address indexed to, uint256 amount, uint256 fee);
    /// @notice The owner cache was set or revalidated under the verifier's current revision.
    event OwnerRefreshed(address indexed verifier, address indexed owner, uint64 iat);
    /// @notice Default sweep result, including eligible untracked funds; amount is net of fee and may be zero.
    event Swept(address indexed verifier, address indexed token, uint256 amount, uint256 fee, address indexed to, uint256 depositsConsumed);
    /// @notice Funds from a constrained bucket were paid to the wallet the proof resolved to (`amount` net of `fee`).
    event SweptBucket(address indexed verifier, bytes32 indexed constraint, address indexed token, uint256 amount, uint256 fee, address to, uint256 depositsConsumed);
    /// @notice A fee accrued for `verifier`; it stays in the vault until withdrawFees() hands it to the policy.
    event FeeAccrued(address indexed verifier, address indexed token, uint256 amount);
    /// @notice Amount deducted from accrued fees after policy distribution, via token pull or native transfer.
    event FeesDistributed(address indexed verifier, address indexed token, uint256 amount, address policy);

    // setup (factory only, once)
    function initialize(bytes32 nsHash, bytes32 saltCommitment, uint64 minRefundWindow, uint64 maxRefundWindow) external;

    // funding
    /// @notice Fund under the factory's default verifier. A non-zero `constraint` can be used once per funder.
    /// @param ref Opaque application reference emitted in Funded; bytes32(0) for none. Does not affect claims or refunds.
    function fund(address token, uint256 amount, bytes32 constraint, uint64 refundWindow, bytes32 ref) external payable returns (uint256 depositId);
    /// @notice Fund under any verifier the factory's policy allows.
    /// @param ref Opaque application reference emitted in Funded; bytes32(0) for none.
    function fundWith(address verifier, address token, uint256 amount, bytes32 constraint, uint64 refundWindow, bytes32 ref) external payable returns (uint256 depositId);
    /// @notice Factory-only: record a deposit for `funder`; pull ERC-20 from the factory or receive native msg.value.
    /// @param ref Opaque application reference emitted in Funded; bytes32(0) for none.
    function fundFor(address funder, address verifier, address token, uint256 amount, bytes32 constraint, uint64 refundWindow, bytes32 ref) external payable returns (uint256 depositId);
    function refund(uint256 depositId) external;

    // proofs
    /// @notice Present a proof under `verifier` without claiming: sets that verifier's owner wallet
    ///         if the proof is newer than anything seen under it, and retires older proofs.
    function refreshProof(address verifier, bytes calldata proof) external;
    function refreshProofAndSweep(address verifier, bytes calldata proof, address token, uint256 depositCountLimit) external returns (uint256 amount, uint256 consumed);
    /// @notice Apply a proof the vault's own proxy has already verified (msg.sender must be this
    ///         address): the freshness, revision and owner-cache rules of refreshProof without
    ///         re-verifying. Reverts unless `wallet` is the recorded owner under `verifier` afterwards.
    ///         Returns its own selector as acknowledgement so the proxy rejects empty fallbacks.
    ///         The acknowledgement checks compatibility; implementations remain trusted to apply the result.
    function acceptOwnerProof(address verifier, address wallet, uint64 iat) external returns (bytes4);

    // claiming (amounts returned are net of fees)
    /// @notice Sweep a page of the verifier's default bucket to its cached owner. Eligible untracked
    ///         funds are included for the current default verifier when its cache meets the cross-default floor.
    function sweep(address verifier, address token, uint256 depositCountLimit) external returns (uint256 amount, uint256 consumed);
    function sweepUntracked(address token) external returns (uint256 amount);
    function sweepDeposits(address verifier, address token, uint256[] calldata depositIds) external returns (uint256 amount);
    function sweepBucket(address verifier, IP2IDVerifier.Constraint calldata constraint, address token, bytes calldata proof, uint256 depositCountLimit) external returns (uint256 amount, uint256 consumed);
    function sweepBucketDeposits(address verifier, IP2IDVerifier.Constraint calldata constraint, address token, uint256[] calldata depositIds, bytes calldata proof) external returns (uint256 amount);

    // fees
    /// @notice Hand the fees earned through `verifier` in `token` to the current policy to distribute. Anyone may call it.
    function withdrawFees(address verifier, address token) external returns (uint256 amount);

    // views
    /// @notice P2ID vault interface version implemented by this contract.
    function p2idVersion() external pure returns (string memory);
    function MAX_FEE_BPS() external view returns (uint16);
    /// @notice Record cap for cursor-based sweeps; a zero or above-cap depositCountLimit uses this value.
    function MAX_SWEEP_PAGE() external view returns (uint256);
    /// @notice address(0): the token address standing for the native coin.
    function NATIVE() external view returns (address);
    /// @notice Namespace value supplied at initialization; not used to recompute this vault's address.
    function nsHash() external view returns (bytes32);
    function factory() external view returns (address);
    function policy() external view returns (address);
    function defaultVerifier() external view returns (address);
    function owner(address verifier) external view returns (address);
    function latestProofIat(address verifier) external view returns (uint64);
    /// @notice Freshness floor for direct transfers, carried across default-verifier changes.
    function untrackedProofIat() external view returns (uint64);
    function saltCommitment() external view returns (bytes32);
    function depositCount() external view returns (uint256);
    /// @notice A page of the bucket's deposit ids: up to `limit` from `offset` (limit 0 = all from `offset`).
    function bucketDepositIds(address verifier, bytes32 constraint, address token, uint256 offset, uint256 limit) external view returns (uint256[] memory);
    function bucketDepositCount(address verifier, bytes32 constraint, address token) external view returns (uint256);
    /// @notice Deposit recorded for a nonzero constraint and funder in this vault. The record persists
    ///         after a refund or claim and prevents the same funder from reusing that constraint here.
    function constraintDeposit(bytes32 constraint, address funder) external view returns (bool used, uint256 depositId);
    function bucketTotal(address verifier, bytes32 constraint, address token) external view returns (uint256);
    function trackedTotal(address token) external view returns (uint256);
    function feesOwed(address verifier, address token) external view returns (uint256);
    function feesOwedTotal(address token) external view returns (uint256);
    /// @notice Total default-bucket amount plus eligible untracked funds, before fees.
    ///         Does not apply the sweep page limit or validate default-bucket claimability.
    function sweepable(address verifier, address token) external view returns (uint256);
    function untrackedBalance(address token) external view returns (uint256);

    struct AlphaAttestation {
        uint256 nonce;
        uint256 deadline;
        bytes signature;
    }

    // Alpha authorization: same vault API, additional signed entry points.
    function supportsAlphaGuard() external pure returns (bool);
    /// @notice Whether a caller-supplied random nonce has been consumed by an alpha business call.
    function alphaNonceUsed(uint256 nonce) external view returns (bool);
    function executeWithAttestation(bytes calldata action, AlphaAttestation calldata attestation) external returns (bytes memory);
    /// @notice Alpha entry points: sign the ABI-encoded ordinary method with its original arguments.
    ///         Ordinary methods require no signature when factory.isAlpha(verifier.vkHash()) is false.
    function refreshProofWithAttestation(address verifier, bytes calldata proof, AlphaAttestation calldata attestation) external;
    function refreshProofAndSweepWithAttestation(address verifier, bytes calldata proof, address token, uint256 depositCountLimit, AlphaAttestation calldata attestation) external returns (uint256 amount, uint256 consumed);
    function sweepBucketWithAttestation(address verifier, IP2IDVerifier.Constraint calldata constraint, address token, bytes calldata proof, uint256 depositCountLimit, AlphaAttestation calldata attestation) external returns (uint256 amount, uint256 consumed);
    function sweepBucketDepositsWithAttestation(address verifier, IP2IDVerifier.Constraint calldata constraint, address token, uint256[] calldata depositIds, bytes calldata proof, AlphaAttestation calldata attestation) external returns (uint256 amount);
}
