// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title SonPorsiyon - open surplus-food reservation and handoff state machine
/// @notice This contract proves digital publication, reservation, release and pickup.
/// It does not prove food existence, safety, quantity or consumption.
contract SurplusPortions {
    enum PortionState { Available, Claimed, Redeemed, Expired }

    struct Batch {
        address provider;
        bytes32 metadataHash;
        string metadataURI;
        uint48 pickupDeadline;
        uint32 claimTtl;
        uint32 slotCount;
        bool exists;
    }

    struct Portion {
        address claimant;
        bytes32 claimantIdentity;
        bytes32 pickupCommitment;
        uint48 claimExpiresAt;
        PortionState state;
    }

    address public immutable owner;
    uint256 private batchNonce;
    mapping(address provider => bool approved) public approvedProviders;
    mapping(bytes32 batchId => Batch batch) public batches;
    mapping(bytes32 batchId => mapping(uint32 slotId => Portion portion)) public portions;
    mapping(bytes32 batchId => mapping(bytes32 nullifier => bool used)) public usedNullifiers;
    mapping(bytes32 batchId => mapping(address claimant => bool used)) public claimedByAddress;
    mapping(bytes32 batchId => mapping(bytes32 identity => bool used)) public claimedByIdentity;
    mapping(bytes32 identity => uint256 nonce) public p256Nonces;

    address private constant P256VERIFY = address(0x100);
    uint256 private constant P256_N_HALF = 0x7fffffff800000007fffffffffffffffde737d56d38bcf4279dce5617e3192a8;

    event ProviderApprovalSet(address indexed provider, bool approved);
    event BatchCreated(bytes32 indexed batchId, address indexed provider, bytes32 metadataHash, string metadataURI, uint48 pickupDeadline, uint32 claimTtl, uint32 slotCount);
    event PortionClaimed(bytes32 indexed batchId, uint32 indexed slotId, address indexed claimant, bytes32 nullifier, bytes32 pickupCommitment, uint48 claimExpiresAt);
    event PortionClaimedP256(bytes32 indexed batchId, uint32 indexed slotId, bytes32 indexed claimantIdentity, bytes32 nullifier, bytes32 pickupCommitment, uint48 claimExpiresAt);
    event PortionReleased(bytes32 indexed batchId, uint32 indexed slotId, address indexed claimant);
    event PortionReleasedP256(bytes32 indexed batchId, uint32 indexed slotId, bytes32 indexed claimantIdentity);
    event PortionRedeemed(bytes32 indexed batchId, uint32 indexed slotId, address indexed claimant);
    event PortionRedeemedP256(bytes32 indexed batchId, uint32 indexed slotId, bytes32 indexed claimantIdentity);
    event PortionExpired(bytes32 indexed batchId, uint32 indexed slotId);

    error UnknownBatch();
    error InvalidBatch();
    error InvalidSlot();
    error PickupWindowClosed();
    error PortionUnavailable();
    error NullifierUsed();
    error AddressAlreadyClaimed();
    error NotClaimant();
    error NotProvider();
    error InvalidPickupSecret();
    error PickupWindowOpen();
    error ProviderNotApproved();
    error NotOwner();
    error InvalidP256Signature();
    error SignatureExpired();

    constructor() {
        owner = msg.sender;
        approvedProviders[msg.sender] = true;
        emit ProviderApprovalSet(msg.sender, true);
    }

    function setProviderApproval(address provider, bool approved) external {
        if (msg.sender != owner) revert NotOwner();
        approvedProviders[provider] = approved;
        emit ProviderApprovalSet(provider, approved);
    }

    function createBatch(bytes32 metadataHash, string calldata metadataURI, uint48 pickupDeadline, uint32 claimTtl, uint32 slotCount) external returns (bytes32 batchId) {
        if (!approvedProviders[msg.sender]) revert ProviderNotApproved();
        if (metadataHash == bytes32(0) || bytes(metadataURI).length == 0 || pickupDeadline <= block.timestamp || claimTtl < 60 || claimTtl > 1 days || slotCount == 0 || slotCount > 500) revert InvalidBatch();
        batchId = keccak256(abi.encode(block.chainid, msg.sender, batchNonce++, metadataHash));
        batches[batchId] = Batch(msg.sender, metadataHash, metadataURI, pickupDeadline, claimTtl, slotCount, true);
        emit BatchCreated(batchId, msg.sender, metadataHash, metadataURI, pickupDeadline, claimTtl, slotCount);
    }

    function claim(bytes32 batchId, uint32 slotId, bytes32 nullifier, bytes32 pickupCommitment) external {
        Batch memory batch = _batch(batchId);
        if (block.timestamp >= batch.pickupDeadline) revert PickupWindowClosed();
        if (slotId >= batch.slotCount) revert InvalidSlot();
        if (pickupCommitment == bytes32(0)) revert InvalidPickupSecret();
        if (usedNullifiers[batchId][nullifier]) revert NullifierUsed();
        if (claimedByAddress[batchId][msg.sender]) revert AddressAlreadyClaimed();
        Portion storage portion = portions[batchId][slotId];
        if (portion.state == PortionState.Claimed && portion.claimExpiresAt <= block.timestamp) {
            address previousClaimant = portion.claimant;
            bytes32 previousIdentity = portion.claimantIdentity;
            _clearClaimFlag(batchId, portion);
            delete portions[batchId][slotId];
            if (previousIdentity == bytes32(0)) emit PortionReleased(batchId, slotId, previousClaimant);
            else emit PortionReleasedP256(batchId, slotId, previousIdentity);
        }
        if (portion.state != PortionState.Available) revert PortionUnavailable();

        portion.claimant = msg.sender;
        portion.claimantIdentity = bytes32(0);
        portion.pickupCommitment = pickupCommitment;
        uint48 ttlExpiry = uint48(block.timestamp + batch.claimTtl);
        portion.claimExpiresAt = ttlExpiry < batch.pickupDeadline ? ttlExpiry : batch.pickupDeadline;
        portion.state = PortionState.Claimed;
        usedNullifiers[batchId][nullifier] = true;
        claimedByAddress[batchId][msg.sender] = true;
        emit PortionClaimed(batchId, slotId, msg.sender, nullifier, pickupCommitment, portion.claimExpiresAt);
    }

    /// @notice Gasless claim path for a non-extractable P-256 device key.
    /// Any relayer may submit the signed action and pay gas. This is intentionally
    /// called a device key, not a WebAuthn passkey: WebAuthn's authenticatorData and
    /// clientDataJSON envelope require a separate verifier.
    function claimWithP256(
        bytes32 batchId,
        uint32 slotId,
        bytes32 nullifier,
        bytes32 pickupCommitment,
        uint48 signatureDeadline,
        bytes32 r,
        bytes32 s,
        bytes32 qx,
        bytes32 qy
    ) external {
        Batch memory batch = _batch(batchId);
        if (block.timestamp >= batch.pickupDeadline) revert PickupWindowClosed();
        if (block.timestamp > signatureDeadline) revert SignatureExpired();
        if (slotId >= batch.slotCount) revert InvalidSlot();
        if (pickupCommitment == bytes32(0)) revert InvalidPickupSecret();
        if (usedNullifiers[batchId][nullifier]) revert NullifierUsed();

        bytes32 identity = keccak256(abi.encodePacked(qx, qy));
        if (claimedByIdentity[batchId][identity]) revert AddressAlreadyClaimed();
        uint256 nonce = p256Nonces[identity];
        bytes32 digest = claimP256Digest(batchId, slotId, nullifier, pickupCommitment, nonce, signatureDeadline);
        if (!_verifyP256(digest, r, s, qx, qy)) revert InvalidP256Signature();

        Portion storage portion = portions[batchId][slotId];
        if (portion.state == PortionState.Claimed && portion.claimExpiresAt <= block.timestamp) {
            address previousClaimant = portion.claimant;
            bytes32 previousIdentity = portion.claimantIdentity;
            _clearClaimFlag(batchId, portion);
            delete portions[batchId][slotId];
            if (previousIdentity == bytes32(0)) emit PortionReleased(batchId, slotId, previousClaimant);
            else emit PortionReleasedP256(batchId, slotId, previousIdentity);
        }
        if (portion.state != PortionState.Available) revert PortionUnavailable();

        uint48 ttlExpiry = uint48(block.timestamp + batch.claimTtl);
        portion.claimant = address(0);
        portion.claimantIdentity = identity;
        portion.pickupCommitment = pickupCommitment;
        portion.claimExpiresAt = ttlExpiry < batch.pickupDeadline ? ttlExpiry : batch.pickupDeadline;
        portion.state = PortionState.Claimed;
        usedNullifiers[batchId][nullifier] = true;
        claimedByIdentity[batchId][identity] = true;
        p256Nonces[identity] = nonce + 1;
        emit PortionClaimedP256(batchId, slotId, identity, nullifier, pickupCommitment, portion.claimExpiresAt);
    }

    function release(bytes32 batchId, uint32 slotId) external {
        Portion storage portion = portions[batchId][slotId];
        if (portion.state != PortionState.Claimed || portion.claimantIdentity != bytes32(0) || portion.claimant != msg.sender) revert NotClaimant();
        claimedByAddress[batchId][msg.sender] = false;
        delete portions[batchId][slotId];
        emit PortionReleased(batchId, slotId, msg.sender);
    }

    function releaseWithP256(
        bytes32 batchId,
        uint32 slotId,
        uint48 signatureDeadline,
        bytes32 r,
        bytes32 s,
        bytes32 qx,
        bytes32 qy
    ) external {
        if (block.timestamp > signatureDeadline) revert SignatureExpired();
        bytes32 identity = keccak256(abi.encodePacked(qx, qy));
        Portion storage portion = portions[batchId][slotId];
        if (portion.state != PortionState.Claimed || portion.claimantIdentity != identity) revert NotClaimant();
        uint256 nonce = p256Nonces[identity];
        bytes32 digest = sha256(abi.encodePacked("SONPORSIYON_RELEASE_P256_V1", block.chainid, address(this), batchId, slotId, nonce, signatureDeadline));
        if (!_verifyP256(digest, r, s, qx, qy)) revert InvalidP256Signature();
        p256Nonces[identity] = nonce + 1;
        claimedByIdentity[batchId][identity] = false;
        delete portions[batchId][slotId];
        emit PortionReleasedP256(batchId, slotId, identity);
    }

    function redeem(bytes32 batchId, uint32 slotId, bytes32 pickupSecret) external {
        Batch memory batch = _batch(batchId);
        if (msg.sender != batch.provider) revert NotProvider();
        if (block.timestamp >= batch.pickupDeadline) revert PickupWindowClosed();
        Portion storage portion = portions[batchId][slotId];
        if (portion.state != PortionState.Claimed) revert PortionUnavailable();
        if (portion.claimExpiresAt <= block.timestamp) revert PortionUnavailable();
        if (sha256(abi.encodePacked("SONPORSIYON_PICKUP_V1", block.chainid, batchId, slotId, pickupSecret)) != portion.pickupCommitment) revert InvalidPickupSecret();
        portion.state = PortionState.Redeemed;
        if (portion.claimantIdentity == bytes32(0)) emit PortionRedeemed(batchId, slotId, portion.claimant);
        else emit PortionRedeemedP256(batchId, slotId, portion.claimantIdentity);
    }

    function expire(bytes32 batchId, uint32 slotId) external {
        Batch memory batch = _batch(batchId);
        if (block.timestamp < batch.pickupDeadline) revert PickupWindowOpen();
        if (slotId >= batch.slotCount) revert InvalidSlot();
        Portion storage portion = portions[batchId][slotId];
        if (portion.state == PortionState.Redeemed || portion.state == PortionState.Expired) revert PortionUnavailable();
        portion.state = PortionState.Expired;
        emit PortionExpired(batchId, slotId);
    }

    function releaseExpiredClaim(bytes32 batchId, uint32 slotId) external {
        Batch memory batch = _batch(batchId);
        if (block.timestamp >= batch.pickupDeadline) revert PickupWindowClosed();
        Portion storage portion = portions[batchId][slotId];
        if (portion.state != PortionState.Claimed || portion.claimExpiresAt > block.timestamp) revert PortionUnavailable();
        _clearClaimFlag(batchId, portion);
        address previousClaimant = portion.claimant;
        bytes32 previousIdentity = portion.claimantIdentity;
        delete portions[batchId][slotId];
        if (previousIdentity == bytes32(0)) emit PortionReleased(batchId, slotId, previousClaimant);
        else emit PortionReleasedP256(batchId, slotId, previousIdentity);
    }

    function claimP256Digest(
        bytes32 batchId,
        uint32 slotId,
        bytes32 nullifier,
        bytes32 pickupCommitment,
        uint256 nonce,
        uint48 signatureDeadline
    ) public view returns (bytes32) {
        return sha256(abi.encodePacked("SONPORSIYON_CLAIM_P256_V1", block.chainid, address(this), batchId, slotId, nullifier, pickupCommitment, nonce, signatureDeadline));
    }

    function _verifyP256(bytes32 digest, bytes32 r, bytes32 s, bytes32 qx, bytes32 qy) private view returns (bool) {
        if (uint256(s) == 0 || uint256(s) > P256_N_HALF) return false;
        (bool success, bytes memory output) = P256VERIFY.staticcall(abi.encodePacked(digest, r, s, qx, qy));
        return success && output.length == 32 && abi.decode(output, (uint256)) == 1;
    }

    function _clearClaimFlag(bytes32 batchId, Portion storage portion) private {
        if (portion.claimantIdentity == bytes32(0)) claimedByAddress[batchId][portion.claimant] = false;
        else claimedByIdentity[batchId][portion.claimantIdentity] = false;
    }

    function _batch(bytes32 batchId) private view returns (Batch memory batch) {
        batch = batches[batchId];
        if (!batch.exists) revert UnknownBatch();
    }
}
