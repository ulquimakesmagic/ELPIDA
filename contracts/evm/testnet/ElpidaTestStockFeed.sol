// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice TESTNET-ONLY Chainlink-compatible total-return price feed for a test stock (ElpidaTestOndoStock): USD per
/// whole raw token, 8 decimals, multipliers already included, so nothing may scale it again. It is not a Chainlink
/// or Ondo feed and must never be deployed or configured on mainnet.
///
/// The controller (the launchpad treasury) posts prices and a market status, so testnets can rehearse the states
/// ELPIDA's stock gate handles: a fresh price, a closed market, a corporate action (price frozen) and a stale feed
/// (no post within the allowed age). Each round is timestamped when posted; the feed never reports a newer time.
contract ElpidaTestStockFeed {
    uint8 public constant decimals = 8;
    uint256 public constant version = 1;
    /// 0 open, 1 closed, 2 corporate action. Real Ondo/Chainlink feeds do not expose this; the test feed does so
    /// the status can be rehearsed without an off-chain status source.
    uint8 public constant OPEN = 0;
    uint8 public constant CLOSED = 1;
    uint8 public constant CORPORATE_ACTION = 2;
    string public description;
    address public immutable controller;
    uint8 public marketStatus;

    struct Round { int256 answer; uint64 updatedAt; }
    uint80 public latestRound;
    mapping(uint80 => Round) private rounds;

    event Posted(uint80 indexed roundId, int256 answer, uint256 updatedAt);
    event StatusChanged(uint8 status);

    error NotController();
    error InvalidAnswer();
    error InvalidStatus();
    error NoRound();

    constructor(string memory description_, int256 initialAnswer) {
        description = description_; controller = msg.sender;
        _post(initialAnswer);
    }

    modifier onlyController() { if (msg.sender != controller) revert NotController(); _; }

    /// A new price, timestamped now.
    function post(int256 answer) external onlyController { _post(answer); }
    function setMarketStatus(uint8 status) external onlyController {
        if (status > CORPORATE_ACTION) revert InvalidStatus();
        marketStatus = status; emit StatusChanged(status);
    }

    function _post(int256 answer) internal {
        if (answer <= 0) revert InvalidAnswer();
        uint80 id = latestRound + 1;
        rounds[id] = Round(answer, uint64(block.timestamp));
        latestRound = id;
        emit Posted(id, answer, block.timestamp);
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) { return getRoundData(latestRound); }
    function getRoundData(uint80 roundId) public view returns (uint80, int256, uint256, uint256, uint80) {
        Round memory r = rounds[roundId];
        if (r.updatedAt == 0) revert NoRound();
        return (roundId, r.answer, r.updatedAt, r.updatedAt, roundId);
    }
}
