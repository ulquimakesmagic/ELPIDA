// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice TESTNET-ONLY Chainlink-compatible ETH / USD feed for test chains that have no Chainlink feed (Robinhood
/// Chain testnet). One updater (the Elpida server's testnet relay wallet) copies rounds from Chainlink's ETH / USD
/// feed on another test network. Each round keeps the SOURCE round's timestamp, so a relayed price is never fresher
/// than Chainlink's own, and a factory's maximum price age still rejects it when the relay stops. It is not a
/// Chainlink feed and must never be deployed or configured on mainnet.
contract ElpidaRelayFeed {
    uint8 public constant decimals = 8;
    uint256 public constant version = 1;
    string public description;
    /// The Chainlink feed being relayed, on `sourceChainId`. Recorded for transparency; it cannot be read from here.
    address public immutable source;
    uint256 public immutable sourceChainId;
    address public immutable owner;
    address public updater;

    struct Round { int256 answer; uint64 updatedAt; uint80 sourceRound; }
    uint80 public latestRound;
    mapping(uint80 => Round) private rounds;

    event Relayed(uint80 indexed roundId, int256 answer, uint256 updatedAt, uint80 sourceRound);
    event UpdaterChanged(address indexed updater);

    error NotUpdater();
    error NotOwner();
    error InvalidRound();
    error NoRound();

    constructor(string memory description_, address source_, uint256 sourceChainId_, address updater_) {
        if (updater_ == address(0) || source_ == address(0) || sourceChainId_ == 0) revert InvalidRound();
        description = description_; source = source_; sourceChainId = sourceChainId_; owner = msg.sender; updater = updater_;
        emit UpdaterChanged(updater_);
    }

    /// Posts one source round. Rounds only move forward: a newer source round with a newer timestamp, never in the
    /// future, with a positive answer.
    function post(int256 answer, uint256 updatedAt, uint80 sourceRound) external {
        if (msg.sender != updater) revert NotUpdater();
        Round memory last = rounds[latestRound];
        if (!(answer > 0 && updatedAt > last.updatedAt && updatedAt <= block.timestamp && sourceRound > last.sourceRound)) revert InvalidRound();
        uint80 id = latestRound + 1;
        rounds[id] = Round(answer, uint64(updatedAt), sourceRound);
        latestRound = id;
        emit Relayed(id, answer, updatedAt, sourceRound);
    }

    function setUpdater(address updater_) external {
        if (msg.sender != owner) revert NotOwner();
        if (updater_ == address(0)) revert InvalidRound();
        updater = updater_;
        emit UpdaterChanged(updater_);
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return getRoundData(latestRound);
    }

    function getRoundData(uint80 roundId) public view returns (uint80, int256, uint256, uint256, uint80) {
        Round memory r = rounds[roundId];
        if (roundId == 0 || r.updatedAt == 0) revert NoRound();
        return (roundId, r.answer, r.updatedAt, r.updatedAt, roundId);
    }
}
