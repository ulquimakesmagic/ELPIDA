// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice EVM candidate for automatic, permissionless, batched holder payouts.
/// @dev The publisher remains trusted to attest *historical holdings* and the complete
///      recipient set. A Merkle proof verifies consistency with its immutable commitment,
///      not that the publisher's historical balances are truthful. Unrestricted assets
///      and unsupervised mainnet funding are NOT supported by this prototype.
///      Existing curve fees/FDV, vault and wallet funding are unchanged.
contract ElpidaHolderEpochs is ReentrancyGuard {
    using SafeERC20 for IERC20;

    address public immutable publisher;
    uint64 public immutable publicationDelay;
    uint256 public nextEpochId;

    struct Epoch {
        address launchToken;
        address payoutAsset;
        bytes32 root;
        bytes32 manifestHash;
        uint256 snapshotBlock;
        uint256 minimumHolding;
        uint256 budget;
        uint256 paidAmount;
        uint32 recipientCount;
        uint32 paidCount;
        uint64 readyAt;
    }

    mapping(uint256 => Epoch) public epochs;
    mapping(uint256 => mapping(address => bool)) public epochPaid;
    mapping(address => uint256) public reserved;

    event EpochPublished(
        uint256 indexed epochId, address indexed launchToken, address indexed payoutAsset,
        uint256 snapshotBlock, bytes32 root, bytes32 manifestHash,
        uint256 minimumHolding, uint256 budget, uint32 recipientCount, uint64 readyAt
    );
    event HolderPaid(uint256 indexed epochId, address indexed wallet, address indexed asset, uint256 amount);
    event BatchPaid(uint256 indexed epochId, uint256 recipients, uint256 totalAmount);

    constructor(address publisher_, uint64 publicationDelay_) {
        require(publisher_ != address(0), "publisher");
        publisher = publisher_;
        publicationDelay = publicationDelay_;
    }

    /// @notice Pre-fund by transferring an approved, standard ERC20 directly to this
    ///         contract, then publish an epoch. Reservations prevent the same balance
    ///         from being committed twice. Funding from a reward vault needs a separately
    ///         audited adapter; do not treat pre-funding as an arbitrary wallet balance.
    function publishEpoch(
        uint256 epochId,
        address launchToken,
        address payoutAsset,
        uint256 snapshotBlock,
        uint256 minimumHolding,
        bytes32 root,
        bytes32 manifestHash,
        uint256 budget,
        uint32 recipientCount
    ) external {
        require(msg.sender == publisher, "publisher only");
        require(epochId == nextEpochId + 1, "epoch sequence");
        require(launchToken.code.length > 0 && payoutAsset.code.length > 0, "asset code");
        require(snapshotBlock < block.number, "snapshot must be past");
        require(minimumHolding > 0 && root != bytes32(0) && manifestHash != bytes32(0), "commitment");
        require(budget > 0 && recipientCount > 0, "empty epoch");
        uint256 available = IERC20(payoutAsset).balanceOf(address(this));
        require(available >= reserved[payoutAsset] && available - reserved[payoutAsset] >= budget, "unfunded epoch");
        uint64 readyAt = uint64(block.timestamp + publicationDelay);
        reserved[payoutAsset] += budget;
        nextEpochId = epochId;
        epochs[epochId] = Epoch({
            launchToken: launchToken, payoutAsset: payoutAsset, root: root,
            manifestHash: manifestHash, snapshotBlock: snapshotBlock,
            minimumHolding: minimumHolding, budget: budget, paidAmount: 0,
            recipientCount: recipientCount, paidCount: 0, readyAt: readyAt
        });
        emit EpochPublished(epochId, launchToken, payoutAsset, snapshotBlock, root,
            manifestHash, minimumHolding, budget, recipientCount, readyAt);
    }

    /// @dev Double-hashed, sorted-pair Merkle leaves compatible with the companion JS
    ///      manifest generator. No arbitrary executor privileges or external calldata.
    function payoutLeaf(
        uint256 epochId, address wallet, uint256 holdingAtSnapshot, uint256 amount
    ) public view returns (bytes32) {
        Epoch storage e = epochs[epochId];
        return keccak256(bytes.concat(keccak256(abi.encode(
            block.chainid, address(this), epochId, e.launchToken,
            e.payoutAsset, e.snapshotBlock, wallet, holdingAtSnapshot, amount
        ))));
    }

    /// @notice Anyone (including a sponsored keeper) can push verified payouts.
    ///         Every batch is atomic and limited to 16 recipients for predictable gas.
    function distributeBatch(
        uint256 epochId,
        address[] calldata wallets,
        uint256[] calldata holdings,
        uint256[] calldata amounts,
        bytes32[][] calldata proofs
    ) external nonReentrant {
        Epoch storage e = epochs[epochId];
        uint256 count = wallets.length;
        require(e.root != bytes32(0) && block.timestamp >= e.readyAt, "epoch not ready");
        require(count > 0 && count <= 16 && count == holdings.length && count == amounts.length && count == proofs.length, "batch size");
        require(uint256(e.paidCount) + count <= e.recipientCount, "too many recipients");
        uint256 total;
        for (uint256 i; i < count; ++i) {
            _validateAndMark(epochId, wallets[i], holdings[i], amounts[i], proofs[i]);
            total += amounts[i];
        }
        require(e.paidAmount + total <= e.budget, "budget exceeded");
        e.paidAmount += total;
        e.paidCount += uint32(count);
        reserved[e.payoutAsset] -= total;
        _sendBatch(epochId, e.payoutAsset, wallets, amounts, total);
        emit BatchPaid(epochId, count, total);
    }

    function _sendBatch(
        uint256 epochId, address asset, address[] calldata wallets,
        uint256[] calldata amounts, uint256 total
    ) private {
        IERC20 token = IERC20(asset);
        uint256 vaultBefore = token.balanceOf(address(this));
        for (uint256 i; i < wallets.length; ++i) {
            _payHolder(token, epochId, wallets[i], amounts[i], asset);
        }
        uint256 vaultAfter = token.balanceOf(address(this));
        require(vaultBefore >= vaultAfter && vaultBefore - vaultAfter == total, "nonstandard token debit");
        require(vaultAfter >= reserved[asset], "insolvent reserve");
    }

    function _validateAndMark(
        uint256 epochId, address wallet, uint256 holding, uint256 amount,
        bytes32[] calldata proof
    ) private {
        Epoch storage e = epochs[epochId];
        require(wallet != address(0) && wallet != address(this) && !epochPaid[epochId][wallet], "already paid");
        require(amount > 0 && holding >= e.minimumHolding, "ineligible");
        require(MerkleProof.verifyCalldata(proof, e.root,
            payoutLeaf(epochId, wallet, holding, amount)), "invalid proof");
        epochPaid[epochId][wallet] = true;
    }

    function _payHolder(
        IERC20 token, uint256 epochId, address wallet, uint256 amount, address asset
    ) private {
        // Fail closed on fee-on-transfer/rebasing/restricted transfers. In such
        // cases the entire batch reverts and the epoch remains recoverable.
        uint256 beforeBalance = token.balanceOf(wallet);
        token.safeTransfer(wallet, amount);
        require(token.balanceOf(wallet) - beforeBalance == amount, "nonstandard payout");
        emit HolderPaid(epochId, wallet, asset, amount);
    }
}
