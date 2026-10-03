// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IP2IDVault} from "./interfaces/IP2IDVault.sol";
import {IP2IDVerifier} from "./interfaces/IP2IDVerifier.sol";
import {IP2IDPolicy} from "./interfaces/IP2IDPolicy.sol";
import {IP2IdVaultFactory} from "./interfaces/IP2IdVaultFactory.sol";

/// @title P2IDVault
/// @notice Vault implementation for ERC-20 and native-coin deposits associated with an identity.
///         Uses its immutable factory for policy and default-verifier settings.
/// @dev Deposits are indexed by (verifier, constraint, token). Cursor-based sweeps visit at most
///      MAX_SWEEP_PAGE records; explicit-id sweeps iterate the supplied list. Owner caches and
///      proof floors are per verifier, with an additional cross-default floor for untracked funds.
///      Direct transfers create no deposit record and have no refund entry point. Token accounting
///      relies on the token's reported balances and transfer behavior.
contract P2IDVault is IP2IDVault {
    /// @notice Maximum fee rate recorded or quoted by this implementation: 100 basis points (1%).
    uint16 public constant MAX_FEE_BPS = 100;
    /// @notice Token identifier used for the native coin.
    address public constant NATIVE = address(0);
    uint256 private constant BPS = 10_000;
    /// @dev Gas cap for _query calls. Failed fee/support queries return zero/false; failed revision
    ///      queries invalidate cached-owner reads and prevent proof updates.
    uint256 private constant QUERY_GAS = 50_000;
    /// @notice Record limit for cursor-based sweeps; a zero or larger requested limit uses this value.
    uint256 public constant MAX_SWEEP_PAGE = 100;
    /// @dev Maximum accepted issue time ahead of block.timestamp.
    uint64 private constant FUTURE_SLACK = 15 minutes;

    /// @notice Factory supplied at construction; source of settings and authorized caller of initialize()/fundFor().
    address public immutable factory;
    bytes32 public nsHash;
    bytes32 public saltCommitment;
    uint64 public minRefundWindow;
    uint64 public maxRefundWindow;
    bool private _initialized;

    /// @notice Cached payout wallet per verifier. Equal-time proofs do not replace an existing wallet.
    mapping(address verifier => address) public owner;
    /// @notice Stored issue-time floor checked by _apply for this verifier.
    mapping(address verifier => uint64) public latestProofIat;
    /// @notice Revision stored with the cached owner; _ownerFresh requires equality with the current revision.
    mapping(address verifier => uint64) public ownerRevision;
    /// @notice Freshness floor for direct transfers: the newest proof presented through the verifier
    ///         that was the default at the time. Carries across default changes.
    uint64 public untrackedProofIat;

    /// @notice Deposit records, including consumed records, indexed by id.
    Deposit[] public deposits;

    /// @notice Unconsumed total per (verifier, constraint, token) bucket.
    mapping(address verifier => mapping(bytes32 constraint => mapping(address token => uint256))) public bucketTotal;
    /// @notice Sum of all unconsumed deposits per token.
    mapping(address token => uint256) public trackedTotal;
    /// @dev Deposit ids per bucket, in funding order.
    mapping(address verifier => mapping(bytes32 constraint => mapping(address token => uint256[]))) private _bucketDeposits;
    /// @notice Index into the bucket's deposit list below which every deposit is consumed.
    mapping(address verifier => mapping(bytes32 constraint => mapping(address token => uint256))) public bucketCursor;
    /// @dev keccak256(abi.encode(constraint, funder)) => depositId + 1 for nonzero constraints.
    ///      Entries persist after claims and refunds, preventing reuse by the same funder in this vault.
    mapping(bytes32 => uint256) private _constraintDeposit;
    /// @notice Fees accrued and not yet distributed, per verifier they were earned through and token.
    mapping(address verifier => mapping(address token => uint256)) public feesOwed;
    /// @notice Sum of feesOwed per token: held for distribution, never part of a payout.
    mapping(address token => uint256) public feesOwedTotal;

    /// @dev 2 while a guarded call runs; any other value (including the 0 a fresh proxy starts with) is idle.
    uint256 private reentrancyLock;

    error InvalidRefundWindow();
    error VerifierNotApproved(address verifier);
    error ConstraintsUnsupported(address verifier);
    error InvalidRefundAmount();
    error InvalidToken();
    error OwnerNotInitialized();
    error OwnerRevoked();
    error RevisionUnavailable(address verifier);
    error NotSelf();
    error NotOwnerProof(address owner);
    error ProofFromFuture();
    error ProofTooOld();
    error InvalidWallet();
    error NotFunder();
    error DepositConsumed();
    error DepositNotInBucket(uint256 depositId);
    error ConstraintRequired();
    error ConstraintUsed(uint256 depositId);
    error NotFactory();
    error AlreadyInitialized();
    error RefundNotReady();
    error TokenCallFailed();
    error TokenBalanceQueryFailed();
    error AmountTooLarge();
    error Reentrancy();
    error FeeOverdrawn();
    error NativeValueMismatch();
    error NativeTransferFailed();

    /// @dev This constructor runs only for the implementation; each proxy's storage is set up
    ///      separately by the factory calling initialize(). Address derivation uses proxy creation code.
    /// @param _factory Address embedded in this implementation for internal factory references.
    constructor(address _factory) {
        factory = _factory;
    }

    /// @notice Accept native coin without creating a deposit record.
    /// @dev Calls to a vault proxy with empty calldata are handled by the proxy's own receive().
    receive() external payable {}

    /// @notice Initialize vault settings once; callable only by the configured factory.
    function initialize(
        bytes32 _nsHash,
        bytes32 _saltCommitment,
        uint64 _minRefundWindow,
        uint64 _maxRefundWindow
    ) external onlyFactory {
        if (_initialized) revert AlreadyInitialized();
        if (_minRefundWindow > _maxRefundWindow) revert InvalidRefundWindow();
        _initialized = true;
        nsHash = _nsHash;
        saltCommitment = _saltCommitment;
        minRefundWindow = _minRefundWindow;
        maxRefundWindow = _maxRefundWindow;
    }

    // ------------------------------------------------------------------ alpha authorization

    /// @notice Alpha authorization nonces already consumed by this vault (caller-chosen, single use).
    /// @dev Preserve this mapping and append later storage after the cache bindings below.
    mapping(uint256 => bool) public alphaNonceUsed;
    mapping(address => bytes32) public ownerVkHash;
    mapping(address => uint256) public ownerAlphaRevision;
    error AlphaAuthorizationRequired();
    error InvalidVkHash();
    error InvalidAlphaCall();
    error AlphaNonceAlreadyUsed(uint256 nonce);

    function supportsAlphaGuard() external pure returns (bool) { return true; }

    function executeWithAttestation(bytes calldata action, AlphaAttestation calldata attestation) external validAlphaCall(action) returns (bytes memory) {
        return _dispatchAlphaCall(action, attestation);
    }

    function _dispatchAlphaCall(bytes calldata action, AlphaAttestation memory attestation) private returns (bytes memory) {
        if (action.length < 4) revert InvalidAlphaCall();
        bytes4 selector = bytes4(action[:4]);
        if (selector == IP2IDVault.refreshProof.selector) {
            (address verifier, bytes memory proof) = abi.decode(action[4:], (address, bytes));
            refreshProofWithAttestation(verifier, proof, attestation);
            return hex"";
        }
        if (selector == IP2IDVault.refreshProofAndSweep.selector) {
            (address verifier, bytes memory proof, address token, uint256 depositCountLimit) = abi.decode(action[4:], (address, bytes, address, uint256));
            (uint256 amount, uint256 consumed) = refreshProofAndSweepWithAttestation(verifier, proof, token, depositCountLimit, attestation);
            return abi.encode(amount, consumed);
        }

        if (selector == IP2IDVault.sweepBucket.selector) {
            (address verifier, IP2IDVerifier.Constraint memory constraint, address token, bytes memory proof, uint256 depositCountLimit) = abi.decode(action[4:], (address, IP2IDVerifier.Constraint, address, bytes, uint256));
            (uint256 amount, uint256 consumed) = sweepBucketWithAttestation(verifier, constraint, token, proof, depositCountLimit, attestation);
            return abi.encode(amount, consumed);
        }
        if (selector == IP2IDVault.sweepBucketDeposits.selector) {
            (address verifier, IP2IDVerifier.Constraint memory constraint, address token, uint256[] memory depositIds, bytes memory proof) = abi.decode(action[4:], (address, IP2IDVerifier.Constraint, address, uint256[], bytes));
            return abi.encode(sweepBucketDepositsWithAttestation(verifier, constraint, token, depositIds, proof, attestation));
        }

        revert InvalidAlphaCall();
    }

    function refreshProofWithAttestation(address verifier, bytes memory proof, AlphaAttestation memory attestation)
        public nonReentrant
        alphaAttestationRequired(verifier, attestation, abi.encodeCall(IP2IDVault.refreshProof, (verifier, proof)))
    {
        _refreshProof(verifier, proof);
    }

    function _refreshProof(address verifier, bytes memory proof) private {
        _present(verifier, proof, _noConstraint());
    }

    function refreshProofAndSweepWithAttestation(address verifier, bytes memory proof, address token, uint256 depositCountLimit, AlphaAttestation memory attestation)
        public nonReentrant
        alphaAttestationRequired(verifier, attestation, abi.encodeCall(IP2IDVault.refreshProofAndSweep, (verifier, proof, token, depositCountLimit)))
        returns (uint256 amount, uint256 consumed)
    {
        return _refreshProofAndSweep(verifier, proof, token, depositCountLimit);
    }

    function _refreshProofAndSweep(address verifier, bytes memory proof, address token, uint256 depositCountLimit) private returns (uint256 amount, uint256 consumed) {
        _present(verifier, proof, _noConstraint());
        return _sweepDefault(verifier, token, depositCountLimit);
    }

    function _sweep(address verifier, address token, uint256 depositCountLimit) private returns (uint256 amount, uint256 consumed) {
        return _sweepDefault(verifier, token, depositCountLimit); // checks the owner is set and current
    }

    function _sweepUntracked(address token) private returns (uint256 amount) {
        address verifier = defaultVerifier();
        address to = _ownerOf(verifier);
        if (latestProofIat[verifier] < untrackedProofIat) revert ProofTooOld();
        uint256 gross = _untrackedBalance(token);
        uint256 fee = (gross * _quoteFeeBps(verifier, token)) / BPS;
        uint256 charged;
        (amount, charged) = _payout(verifier, token, to, gross, fee);
        emit Swept(verifier, token, amount, charged, to, 0);
    }

    function _sweepDeposits(address verifier, address token, uint256[] memory depositIds) private onlyInitialized(verifier) returns (uint256 amount) {
        address to = owner[verifier];
        (uint256 gross, uint256 fee) = _consumeIds(verifier, bytes32(0), token, depositIds, to);
        uint256 charged;
        (amount, charged) = _payout(verifier, token, to, gross, fee);
        emit Swept(verifier, token, amount, charged, to, depositIds.length);
    }

    function sweepBucketWithAttestation(address verifier, IP2IDVerifier.Constraint memory constraint, address token, bytes memory proof, uint256 depositCountLimit, AlphaAttestation memory attestation)
        public nonReentrant
        alphaAttestationRequired(verifier, attestation, abi.encodeCall(IP2IDVault.sweepBucket, (verifier, constraint, token, proof, depositCountLimit)))
        returns (uint256 amount, uint256 consumed)
    {
        return _sweepBucket(verifier, constraint, token, proof, depositCountLimit);
    }

    function _sweepBucket(address verifier, IP2IDVerifier.Constraint memory constraint, address token, bytes memory proof, uint256 depositCountLimit) private returns (uint256 amount, uint256 consumed) {
        address to = _verifyForThisVault(verifier, proof, constraint);
        uint256 gross;
        uint256 fee;
        (gross, fee, consumed) = _consumeFromCursor(verifier, constraint.commitment, token, depositCountLimit, to);
        uint256 charged;
        (amount, charged) = _payout(verifier, token, to, gross, fee);
        emit SweptBucket(verifier, constraint.commitment, token, amount, charged, to, consumed);
    }

    function sweepBucketDepositsWithAttestation(address verifier, IP2IDVerifier.Constraint memory constraint, address token, uint256[] memory depositIds, bytes memory proof, AlphaAttestation memory attestation)
        public nonReentrant
        alphaAttestationRequired(verifier, attestation, abi.encodeCall(IP2IDVault.sweepBucketDeposits, (verifier, constraint, token, depositIds, proof)))
        returns (uint256 amount)
    {
        return _sweepBucketDeposits(verifier, constraint, token, depositIds, proof);
    }

    function _sweepBucketDeposits(address verifier, IP2IDVerifier.Constraint memory constraint, address token, uint256[] memory depositIds, bytes memory proof) private returns (uint256 amount) {
        address to = _verifyForThisVault(verifier, proof, constraint);
        (uint256 gross, uint256 fee) = _consumeIds(verifier, constraint.commitment, token, depositIds, to);
        uint256 charged;
        (amount, charged) = _payout(verifier, token, to, gross, fee);
        emit SweptBucket(verifier, constraint.commitment, token, amount, charged, to, depositIds.length);
    }

    function _withdrawFees(address verifier, address token) private returns (uint256 amount) {
        uint256 owed = feesOwed[verifier][token];
        if (owed == 0) return 0;
        address pol = policy();
        if (token == NATIVE) {
            // Native coin cannot be pulled: it is sent along with the call, exactly the amount owed.
            IP2IDPolicy(pol).distributeFee{value: owed}(verifier, token, owed);
            amount = owed;
        } else {
            uint256 before = _balanceOf(token);
            _callToken(token, abi.encodeWithSignature("approve(address,uint256)", pol, owed));
            IP2IDPolicy(pol).distributeFee(verifier, token, owed);
            _callToken(token, abi.encodeWithSignature("approve(address,uint256)", pol, 0));
            uint256 afterBalance = _balanceOf(token);
            amount = before > afterBalance ? before - afterBalance : 0;
            if (amount > owed) revert FeeOverdrawn();
        }
        feesOwed[verifier][token] = owed - amount;
        feesOwedTotal[token] -= amount;
        emit FeesDistributed(verifier, token, amount, pol);
    }

    modifier validAlphaCall(bytes calldata action) {
        if (action.length < 4) revert InvalidAlphaCall();
        bytes4 selector = bytes4(action[:4]);
        if (!(selector == IP2IDVault.refreshProof.selector || selector == IP2IDVault.refreshProofAndSweep.selector || selector == IP2IDVault.sweepBucket.selector || selector == IP2IDVault.sweepBucketDeposits.selector)) revert InvalidAlphaCall();
        _;
    }

    /// @dev Empty signatures are allowed only after alpha. Bind approval to the entire ordinary call.
    modifier alphaAttestationRequired(address verifier, AlphaAttestation memory attestation, bytes memory action) {
        if (IP2IdVaultFactory(factory).isAlpha(IP2IDVerifier(verifier).vkHash())) {
            if (attestation.signature.length == 0) revert AlphaAuthorizationRequired();
            if (alphaNonceUsed[attestation.nonce]) revert AlphaNonceAlreadyUsed(attestation.nonce);
            IP2IdVaultFactory(factory).verifyAlphaAuthorization(address(this), msg.sender, keccak256(action), attestation.nonce, attestation.deadline, attestation.signature);
            alphaNonceUsed[attestation.nonce] = true;
        }
        _;
    }

    // ------------------------------------------------------------------ funding

    /// @notice Fund under the factory's default verifier.
    /// @param token NATIVE for the native coin (send it as msg.value, equal to `amount`), otherwise
    ///        an ERC-20 pulled with transferFrom (approve first; send no value).
    /// @param constraint Opaque bytes32 the verifier must see satisfied before this deposit can
    ///        be swept (e.g. a screening commitment); bytes32(0) for the default bucket.
    /// @param ref Opaque application reference emitted in Funded; bytes32(0) for none.
    function fund(
        address token,
        uint256 amount,
        bytes32 constraint,
        uint64 refundWindow,
        bytes32 ref
    ) external payable nonReentrant returns (uint256 depositId) {
        return _fund(msg.sender, defaultVerifier(), token, amount, constraint, refundWindow, ref);
    }

    /// @notice Fund under any verifier the factory's policy allows. Native coin as in fund().
    /// @param ref Opaque application reference emitted in Funded; bytes32(0) for none.
    function fundWith(
        address verifier,
        address token,
        uint256 amount,
        bytes32 constraint,
        uint64 refundWindow,
        bytes32 ref
    ) external payable nonReentrant returns (uint256 depositId) {
        return _fund(msg.sender, verifier, token, amount, constraint, refundWindow, ref);
    }

    /// @notice Factory-only: record a deposit for `funder`. ERC-20 tokens are pulled from the
    ///         factory; native coin is supplied as msg.value.
    /// @param ref Opaque application reference emitted in Funded; bytes32(0) for none.
    function fundFor(
        address funder,
        address verifier,
        address token,
        uint256 amount,
        bytes32 constraint,
        uint64 refundWindow,
        bytes32 ref
    ) external payable nonReentrant onlyFactory returns (uint256 depositId) {
        if (funder == address(0)) revert InvalidWallet();
        return _fund(funder, verifier, token, amount, constraint, refundWindow, ref);
    }

    /// @dev Receive native msg.value or pull ERC-20 from msg.sender, crediting the reported balance
    ///      increase for ERC-20. Record a deposit owned by `funder`, with the fee
    ///      rate the policy quotes now (capped) fixed for it.
    function _fund(
        address funder,
        address verifier,
        address token,
        uint256 amount,
        bytes32 constraint,
        uint64 refundWindow,
        bytes32 ref
    ) private onlyAllowed(verifier) returns (uint256 depositId) {
        bytes32 constraintKey;
        if (constraint != bytes32(0)) {
            if (!_supportsConstraints(verifier)) revert ConstraintsUnsupported(verifier);
            constraintKey = keccak256(abi.encode(constraint, funder));
            if (_constraintDeposit[constraintKey] != 0) revert ConstraintUsed(_constraintDeposit[constraintKey] - 1);
        }
        if (refundWindow < minRefundWindow || refundWindow > maxRefundWindow) revert InvalidRefundWindow();
        if (amount == 0 || amount > type(uint128).max) revert InvalidRefundAmount();

        uint256 credited;
        if (token == NATIVE) {
            if (msg.value != amount) revert NativeValueMismatch();
            credited = amount;
        } else {
            if (msg.value != 0) revert NativeValueMismatch(); // ERC-20 deposits do not accept msg.value
            if (token.code.length == 0) revert InvalidToken();
            uint256 beforeBalance = _balanceOf(token);
            _callToken(token, abi.encodeWithSignature("transferFrom(address,address,uint256)", msg.sender, address(this), amount));
            uint256 afterBalance = _balanceOf(token);
            if (afterBalance <= beforeBalance) revert InvalidRefundAmount();
            credited = afterBalance - beforeBalance;
            if (credited > type(uint128).max) revert AmountTooLarge();
        }

        uint16 feeBps = _quoteFeeBps(verifier, token);
        depositId = deposits.length;
        deposits.push(
            Deposit({
                funder: funder,
                fundedAt: uint64(block.timestamp),
                consumed: false,
                token: token,
                refundWindow: refundWindow,
                verifier: verifier,
                feeBps: feeBps,
                amount: uint128(credited),
                constraint: constraint
            })
        );
        if (constraint != bytes32(0)) _constraintDeposit[constraintKey] = depositId + 1;
        _bucketDeposits[verifier][constraint][token].push(depositId);
        bucketTotal[verifier][constraint][token] += credited;
        trackedTotal[token] += credited;
        emit Funded(depositId, funder, token, credited, verifier, constraint, refundWindow, feeBps, ref);
    }

    /// @notice Return an unconsumed deposit to its funder after its refund window. Never charges a
    ///         fee and never consults the policy.
    function refund(uint256 depositId) external nonReentrant {
        Deposit storage deposit = deposits[depositId];
        if (deposit.funder != msg.sender) revert NotFunder();
        if (deposit.consumed) revert DepositConsumed();
        if (block.timestamp <= uint256(deposit.fundedAt) + deposit.refundWindow) revert RefundNotReady();

        _consume(deposit);
        _transfer(deposit.token, msg.sender, deposit.amount);
        emit Refunded(depositId, msg.sender, deposit.token, deposit.amount);
    }

    // ------------------------------------------------------------------ proofs

    /// @notice Verify a proof and update this verifier's owner cache and issue-time floor using _apply.
    function refreshProof(address verifier, bytes memory proof) external {
        refreshProofWithAttestation(verifier, proof, AlphaAttestation(0, 0, hex""));
    }

    /// @notice Present a proof, then sweep `verifier`'s default bucket for `token`.
    /// @param depositCountLimit Number of deposit records to visit from the bucket cursor (not
    ///        an amount, not an index); zero or above MAX_SWEEP_PAGE uses MAX_SWEEP_PAGE.
    /// @dev Includes untracked funds only when _paysUntracked(verifier) is true.
    function refreshProofAndSweep(
        address verifier,
        bytes memory proof,
        address token,
        uint256 depositCountLimit
    ) external returns (uint256 amount, uint256 consumed) {
        return refreshProofAndSweepWithAttestation(verifier, proof, token, depositCountLimit, AlphaAttestation(0, 0, hex""));
    }

    // ------------------------------------------------------------------ claiming

    /// @notice Sweep `verifier`'s default bucket for `token` to that verifier's owner. Walks only
    ///         this bucket's list from its cursor; `depositCountLimit` records per call (0 = MAX_SWEEP_PAGE, also the cap).
    ///         Includes untracked funds when the verifier is the current default and its owner cache
    ///         meets the revision and untrackedProofIat checks.
    function sweep(address verifier, address token, uint256 depositCountLimit) external nonReentrant returns (uint256 amount, uint256 consumed) {
        return _sweep(verifier, token, depositCountLimit);
    }

    /// @notice Sweep only untracked ERC-20 or native funds to
    ///         the default verifier's owner. The fee rate is quoted now.
    function sweepUntracked(address token) external nonReentrant returns (uint256 amount) {
        return _sweepUntracked(token);
    }

    /// @notice Sweep specific default-bucket deposits of `verifier` by id (e.g. to skip spam in the same bucket).
    function sweepDeposits(address verifier, address token, uint256[] memory depositIds) external nonReentrant returns (uint256 amount) {
        return _sweepDeposits(verifier, token, depositIds);
    }

    /// @notice Sweep the bucket funded under `verifier` and `constraint.commitment`. The verifier
    ///         must accept both the identity proof and the constraint evidence; funds go to the
    ///         wallet the proof resolves to. This entry point rejects a zero commitment.
    function sweepBucket(
        address verifier,
        IP2IDVerifier.Constraint memory constraint,
        address token,
        bytes memory proof,
        uint256 depositCountLimit
    ) external returns (uint256 amount, uint256 consumed) {
        return sweepBucketWithAttestation(verifier, constraint, token, proof, depositCountLimit, AlphaAttestation(0, 0, hex""));
    }

    /// @notice Sweep specific deposits of a constrained bucket by id.
    function sweepBucketDeposits(
        address verifier,
        IP2IDVerifier.Constraint memory constraint,
        address token,
        uint256[] memory depositIds,
        bytes memory proof
    ) external returns (uint256 amount) {
        return sweepBucketDepositsWithAttestation(verifier, constraint, token, depositIds, proof, AlphaAttestation(0, 0, hex""));
    }

    // ------------------------------------------------------------------ fees

    /// @notice Call the current policy to distribute accrued fees; callable by any address.
    ///         Native fees are sent as msg.value. For ERC-20, approve the accrued amount, reset the
    ///         allowance after the call, and deduct the observed balance decrease; revert if it exceeds fees owed.
    function withdrawFees(address verifier, address token) external nonReentrant returns (uint256 amount) {
        return _withdrawFees(verifier, token);
    }

    // ------------------------------------------------------------------ views

    /// @inheritdoc IP2IDVault
    function p2idVersion() external pure returns (string memory) {
        return "p2id.vault.v1";
    }

    /// @notice Policy address returned by the configured factory.
    function policy() public view returns (address) {
        return IP2IdVaultFactory(factory).policy();
    }

    /// @notice Default verifier returned by the configured factory, used by fund() and untracked claims.
    function defaultVerifier() public view returns (address) {
        return IP2IdVaultFactory(factory).defaultVerifier();
    }

    function depositCount() external view returns (uint256) {
        return deposits.length;
    }

    /// @notice A page of a bucket's deposit ids, in funding order (consumed ones included; see
    ///         `deposits`): up to `limit` ids from `offset`, or all from `offset` when `limit` is 0.
    function bucketDepositIds(address verifier, bytes32 constraint, address token, uint256 offset, uint256 limit)
        external
        view
        returns (uint256[] memory ids)
    {
        uint256[] storage all = _bucketDeposits[verifier][constraint][token];
        if (offset >= all.length) return ids;
        uint256 end = all.length;
        if (limit != 0 && end - offset > limit) end = offset + limit;
        ids = new uint256[](end - offset);
        for (uint256 k = offset; k < end; k++) ids[k - offset] = all[k];
    }

    function bucketDepositCount(address verifier, bytes32 constraint, address token) external view returns (uint256) {
        return _bucketDeposits[verifier][constraint][token].length;
    }

    /// @notice Recorded deposit for a nonzero constraint and funder; the record persists after consumption.
    function constraintDeposit(bytes32 constraint, address funder) external view returns (bool used, uint256 depositId) {
        uint256 stored = _constraintDeposit[keccak256(abi.encode(constraint, funder))];
        return stored == 0 ? (false, 0) : (true, stored - 1);
    }

    /// @notice Total default-bucket amount plus untracked funds when _paysUntracked is true.
    /// @dev Does not apply the sweep page limit or validate default-bucket claimability.
    function sweepable(address verifier, address token) external view returns (uint256) {
        uint256 amount = bucketTotal[verifier][bytes32(0)][token];
        if (_paysUntracked(verifier)) amount += _untrackedBalance(token);
        return amount;
    }

    /// @notice Reported balance minus tracked deposits and accrued fees, floored at zero; supports native coin.
    function untrackedBalance(address token) external view returns (uint256) {
        return _untrackedBalance(token);
    }

    // ------------------------------------------------------------------ internals

    /// @dev Check verifier claimability, request verification for saltCommitment, then apply the
    ///      returned wallet and issue time. Proxy-verified results enter through acceptOwnerProof.
    function _present(
        address verifier,
        bytes memory proof,
        IP2IDVerifier.Constraint memory constraint
    ) private onlyClaimable(verifier) returns (address wallet) {
        uint64 iat;
        (wallet, iat) = IP2IDVerifier(verifier).getIdentityWallet(saltCommitment, proof, constraint);
        _apply(verifier, wallet, iat);
    }

    /// @notice Apply a proxy-verified wallet and issue time; require msg.sender == address(this).
    ///         Revert unless wallet is the cached owner afterwards, then return the hook selector.
    /// @dev The self-call check relies on the proxy verifying the result before invoking this hook.
    function acceptOwnerProof(address verifier, address wallet, uint64 iat)
        external
        nonReentrant
        onlyClaimable(verifier)
        returns (bytes4)
    {
        if (msg.sender != address(this)) revert NotSelf();
        _apply(verifier, wallet, iat);
        if (owner[verifier] != wallet) revert NotOwnerProof(owner[verifier]);
        return IP2IDVault.acceptOwnerProof.selector; // compatibility acknowledgement after applying the result
    }

    /// @dev The freshness and revision rules for a verified (wallet, iat) under `verifier`: refuses
    ///      proofs older than the newest seen, and makes a newer wallet the owner.
    function _apply(address verifier, address wallet, uint64 iat) private {
        if (wallet == address(0)) revert InvalidWallet();
        // Bound the issue time before storing it as a freshness floor.
        if (iat > block.timestamp + FUTURE_SLACK) revert ProofFromFuture();
        (bool revOk, uint64 rev) = _revision(verifier);
        if (!revOk) revert RevisionUnavailable(verifier);
        bool fresh = _ownerFresh(verifier);
        // Revision changes do not reset this verifier's stored issue-time floor.
        uint64 latest = latestProofIat[verifier];
        if (iat < latest) revert ProofTooOld();
        if (iat > latest || owner[verifier] == address(0)) {
            owner[verifier] = wallet;
            latestProofIat[verifier] = iat;
            ownerRevision[verifier] = rev;
            emit OwnerRefreshed(verifier, wallet, iat);
        } else if (!fresh && wallet == owner[verifier]) {
            // Re-validating the recorded wallet after a revision change: the same proof (or one of
            // the same age for the same wallet) restores it. Changing wallets takes a newer proof.
            ownerRevision[verifier] = rev;
            emit OwnerRefreshed(verifier, wallet, iat);
        }
        if (wallet == owner[verifier] && iat == latestProofIat[verifier]) {
            bytes32 key = IP2IDVerifier(verifier).vkHash();
            if (key == bytes32(0)) revert InvalidVkHash();
            ownerVkHash[verifier] = key;
            ownerAlphaRevision[verifier] = IP2IdVaultFactory(factory).alphaRevision(key);
        }
        if (iat > untrackedProofIat && verifier == defaultVerifier()) untrackedProofIat = iat;
        // Otherwise iat == latest with the owner set: a same-age proof (a replayed copy, or another
        // wallet slot of the same token). The owner stays, and constrained paths pay `wallet`.
    }

    /// @dev Verify a constrained claim; reject zero commitments at this entry point.
    function _verifyForThisVault(
        address verifier,
        bytes memory proof,
        IP2IDVerifier.Constraint memory constraint
    ) private returns (address wallet) {
        if (constraint.commitment == bytes32(0)) revert ConstraintRequired();
        return _present(verifier, proof, constraint);
    }

    /// @dev Whether verifier is the current default, its revision matches the cache, and its
    ///      stored proof time meets untrackedProofIat. Does not check for a nonzero owner.
    function _paysUntracked(address verifier) private view returns (bool) {
        return verifier == defaultVerifier() && _ownerFresh(verifier) && latestProofIat[verifier] >= untrackedProofIat;
    }

    /// @dev Require a claimable verifier, nonzero cached owner and matching readable revision.
    function _ownerOf(address verifier) private view onlyClaimable(verifier) returns (address to) {
        to = owner[verifier];
        if (to == address(0)) revert OwnerNotInitialized();
        if (!_ownerFresh(verifier)) revert OwnerRevoked();
    }

    /// @dev Whether the cached owner was proven under the verifier's current revision.
    function _ownerFresh(address verifier) private view returns (bool) {
        (bool ok, uint64 rev) = _revision(verifier);
        if (!ok || ownerRevision[verifier] != rev) return false;
        try IP2IDVerifier(verifier).vkHash() returns (bytes32 key) {
            return key != bytes32(0) && ownerVkHash[verifier] == key
                && ownerAlphaRevision[verifier] == IP2IdVaultFactory(factory).alphaRevision(key);
        } catch { return false; }
    }

    function _noConstraint() private pure returns (IP2IDVerifier.Constraint memory c) {
        c.commitment = bytes32(0);
        c.signature = "";
    }

    /// @dev Consume a page of default-bucket deposits at their stored fee rates. Include untracked
    ///      surplus at the current quoted rate when _paysUntracked returns true.
    function _sweepDefault(address verifier, address token, uint256 depositCountLimit)
        private
        returns (uint256 amount, uint256 consumed)
    {
        // Checked here, not only in sweep(): refreshProofAndSweep reaches this after a proof that
        // may have verified without restoring a void cache (an equal-time proof for another wallet).
        address to = _ownerOf(verifier);
        uint256 untracked = _paysUntracked(verifier) ? _untrackedBalance(token) : 0;
        uint256 gross;
        uint256 fee;
        (gross, fee, consumed) = _consumeFromCursor(verifier, bytes32(0), token, depositCountLimit, to);
        if (untracked != 0) {
            gross += untracked;
            fee += (untracked * _quoteFeeBps(verifier, token)) / BPS;
        }
        uint256 charged;
        (amount, charged) = _payout(verifier, token, to, gross, fee);
        emit Swept(verifier, token, amount, charged, to, consumed);
    }

    function _consumeFromCursor(
        address verifier,
        bytes32 constraint,
        address token,
        uint256 depositCountLimit,
        address to
    ) private returns (uint256 amount, uint256 fee, uint256 consumed) {
        uint256[] storage ids = _bucketDeposits[verifier][constraint][token];
        uint256 i = bucketCursor[verifier][constraint][token];
        uint256 end = ids.length;
        // Limit records visited, including already-consumed entries, to MAX_SWEEP_PAGE.
        uint256 page = (depositCountLimit == 0 || depositCountLimit > MAX_SWEEP_PAGE) ? MAX_SWEEP_PAGE : depositCountLimit;
        if (end - i > page) end = i + page;
        while (i < end) {
            uint256 id = ids[i];
            Deposit storage deposit = deposits[id];
            if (!deposit.consumed) {
                (uint256 a, uint256 f) = _claim(id, deposit, to);
                amount += a;
                fee += f;
                consumed++;
            }
            i++;
        }
        bucketCursor[verifier][constraint][token] = i;
    }

    function _consumeIds(
        address verifier,
        bytes32 constraint,
        address token,
        uint256[] memory depositIds,
        address to
    ) private returns (uint256 amount, uint256 fee) {
        for (uint256 k = 0; k < depositIds.length; k++) {
            uint256 id = depositIds[k];
            if (id >= deposits.length) revert DepositNotInBucket(id);
            Deposit storage deposit = deposits[id];
            if (deposit.verifier != verifier || deposit.constraint != constraint || deposit.token != token) {
                revert DepositNotInBucket(id);
            }
            if (deposit.consumed) revert DepositConsumed();
            (uint256 a, uint256 f) = _claim(id, deposit, to);
            amount += a;
            fee += f;
        }
    }

    /// @dev Consume a deposit for a payout to `to`; its fee is computed at the rate fixed at funding.
    function _claim(uint256 id, Deposit storage deposit, address to) private returns (uint256 amount, uint256 fee) {
        _consume(deposit);
        amount = deposit.amount;
        fee = (amount * deposit.feeBps) / BPS;
        emit Claimed(id, to, amount, fee);
    }

    /// @dev Pay `gross - fee` to `to` and keep `fee` accrued for `verifier`. No policy call.
    ///      Returns (net paid, fee charged).
    function _payout(address verifier, address token, address to, uint256 gross, uint256 fee)
        private
        returns (uint256 net, uint256 charged)
    {
        if (fee != 0) {
            charged = fee;
            feesOwed[verifier][token] += fee;
            feesOwedTotal[token] += fee;
            emit FeeAccrued(verifier, token, fee);
        }
        net = gross - charged;
        if (net != 0) _transfer(token, to, net);
    }

    function _untrackedBalance(address token) private view returns (uint256) {
        uint256 balance = _balanceOf(token);
        uint256 held = trackedTotal[token] + feesOwedTotal[token];
        return balance > held ? balance - held : 0;
    }

    function _consume(Deposit storage deposit) private {
        deposit.consumed = true;
        bucketTotal[deposit.verifier][deposit.constraint][deposit.token] -= deposit.amount;
        trackedTotal[deposit.token] -= deposit.amount;
    }

    // ------------------------------------------------------------------ policy / verifier queries

    function _policy() private view returns (IP2IDPolicy) {
        return IP2IDPolicy(IP2IdVaultFactory(factory).policy());
    }

    /// @dev The policy's fee rate for (verifier, token), capped at MAX_FEE_BPS; 0 if the query fails.
    function _quoteFeeBps(address verifier, address token) private view returns (uint16) {
        (bool ok, uint256 v) = _query(address(_policy()), abi.encodeCall(IP2IDPolicy.feeBps, (verifier, token)));
        if (!ok) return 0;
        return v > MAX_FEE_BPS ? MAX_FEE_BPS : uint16(v);
    }

    /// @dev Query revision() with QUERY_GAS; ok is false on call failure, wrong length or uint64 overflow.
    function _revision(address verifier) private view returns (bool ok, uint64 rev) {
        uint256 v;
        (ok, v) = _query(verifier, abi.encodeCall(IP2IDVerifier.revision, ()));
        if (ok && v > type(uint64).max) ok = false;
        rev = uint64(v);
    }

    /// @dev Whether `verifier` declares it can satisfy constraints; false if it does not say.
    function _supportsConstraints(address verifier) private view returns (bool) {
        (bool ok, uint256 v) = _query(verifier, abi.encodeCall(IP2IDVerifier.supportsConstraints, ()));
        return ok && v == 1;
    }

    /// @dev Gas-capped static call expecting one 32-byte word; (false, 0) on any failure.
    function _query(address target, bytes memory data) private view returns (bool ok, uint256 value) {
        bytes memory ret;
        (ok, ret) = target.staticcall{gas: QUERY_GAS}(data);
        if (!ok || ret.length != 32) return (false, 0);
        value = abi.decode(ret, (uint256));
    }

    // ------------------------------------------------------------------ tokens

    /// @dev Transfer tokens or call the native recipient without an explicit gas limit.
    ///      Entry points reaching this helper hold the reentrancy lock.
    function _transfer(address token, address to, uint256 amount) private {
        if (token == NATIVE) {
            (bool ok, ) = payable(to).call{value: amount}("");
            if (!ok) revert NativeTransferFailed();
        } else {
            _callToken(token, abi.encodeWithSignature("transfer(address,uint256)", to, amount));
        }
    }

    function _balanceOf(address token) private view returns (uint256 balance) {
        if (token == NATIVE) return address(this).balance;
        (bool ok, bytes memory data) = token.staticcall(abi.encodeWithSignature("balanceOf(address)", address(this)));
        if (!ok || data.length != 32) revert TokenBalanceQueryFailed();
        balance = abi.decode(data, (uint256));
    }

    function _callToken(address token, bytes memory input) private {
        (bool ok, bytes memory data) = token.call(input);
        if (!ok || (data.length != 0 && (data.length != 32 || !abi.decode(data, (bool))))) revert TokenCallFailed();
    }

    // ------------------------------------------------------------------ modifiers

    /// @dev Funding: the policy decides which verifiers new deposits may be made under.
    modifier onlyAllowed(address verifier) {
        if (!_policy().isVerifierAllowed(verifier)) revert VerifierNotApproved(verifier);
        _;
    }

    /// @dev Skip policy approval for the current default verifier; check approval for other verifiers.
    modifier onlyClaimable(address verifier) {
        if (verifier != defaultVerifier() && !_policy().isVerifierAllowed(verifier)) revert VerifierNotApproved(verifier);
        _;
    }

    modifier onlyFactory() {
        if (msg.sender != factory) revert NotFactory();
        _;
    }

    /// @dev Require a cached owner that passes _ownerOf's claimability and revision checks.
    modifier onlyInitialized(address verifier) {
        _ownerOf(verifier);
        _;
    }

    modifier nonReentrant() {
        if (reentrancyLock == 2) revert Reentrancy();
        reentrancyLock = 2;
        _;
        reentrancyLock = 1;
    }
}
