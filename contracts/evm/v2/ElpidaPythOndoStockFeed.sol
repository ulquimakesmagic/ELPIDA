// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Pyth Core's stored price (docs.pyth.network): price × 10^expo, its confidence interval and publish time.
struct PythPrice { int64 price; uint64 conf; int32 expo; uint256 publishTime; }

/// Pyth Core (BNB Chain 0x4D7E825f…9dE1594): stores the latest verified update per feed id; anyone can push a newer one.
interface IPythCore {
    function getPriceUnsafe(bytes32 id) external view returns (PythPrice memory);
}

/// Ondo's SyntheticSharesOracle: shares per token (18 decimals) and whether the token is paused for a corporate action.
interface IOndoSharesOracleP {
    function getSValue(address asset) external view returns (uint128 sValue, bool paused);
}

/// @notice The USD price of one Ondo stock token from Pyth, read like a Chainlink feed (Malik, 20 November 2026: every
/// Ondo stock Pyth prices, not only the 13 Chainlink covers on BNB Chain). Answers Pyth's price of the underlying share
/// (8 decimals) × Ondo's on-chain multiplier (`sValue`), with Pyth's publish time as the round's time, so the V2
/// factory's own checks (positive, answered, at most the pair's maximum age) apply unchanged. It refuses while Ondo
/// pauses the token for a corporate action, and when Pyth's confidence interval is wider than `maxConfBps` of the price.
/// Pyth is a pull oracle: the launch page pushes a fresh signed update to Pyth Core just before a launch, so the price
/// used is current; without a push, the last stored price applies and the factory's age limit still bounds it.
/// Nothing here can be changed after deployment.
/// @dev Elpida is not affiliated with Ondo or Pyth; both are read as public on-chain data.
contract ElpidaPythOndoStockFeed {
    uint256 public constant VERSION = 1;
    uint8 public constant decimals = 8;
    IPythCore public immutable pyth;
    bytes32 public immutable priceId;
    IOndoSharesOracleP public immutable sharesOracle;
    address public immutable token;
    uint16 public immutable maxConfBps;
    string public description;

    error OndoPaused();
    error BadAnswer();
    error WideConfidence();

    constructor(address pyth_, bytes32 priceId_, address sharesOracle_, address token_, uint16 maxConfBps_, string memory description_) {
        require(pyth_.code.length > 0 && sharesOracle_.code.length > 0 && token_.code.length > 0, "contracts");
        require(priceId_ != bytes32(0), "price id");
        require(maxConfBps_ > 0 && maxConfBps_ <= 1000, "confidence");
        require(bytes(description_).length > 0 && bytes(description_).length <= 96, "description");
        (uint128 s,) = IOndoSharesOracleP(sharesOracle_).getSValue(token_);
        require(s > 0, "sValue");
        pyth = IPythCore(pyth_); priceId = priceId_; sharesOracle = IOndoSharesOracleP(sharesOracle_); token = token_;
        maxConfBps = maxConfBps_; description = description_;
    }

    function latestRoundData() external view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound) {
        PythPrice memory p = pyth.getPriceUnsafe(priceId);
        if (p.price <= 0 || p.publishTime == 0 || p.expo > 0 || p.expo < -18) revert BadAnswer();
        uint256 raw = uint256(uint64(p.price));
        if (uint256(p.conf) * 10_000 > raw * maxConfBps) revert WideConfidence();
        (uint128 s, bool paused) = sharesOracle.getSValue(token);
        if (paused) revert OndoPaused();
        if (s == 0) revert BadAnswer();
        // To 8 decimals: Pyth's US equity feeds use expo -5; any exponent from 0 to -18 is handled.
        int32 shift = p.expo + 8;
        uint256 price8 = shift >= 0 ? raw * 10 ** uint32(shift) : raw / 10 ** uint32(-shift);
        uint256 value = price8 * uint256(s) / 1e18;
        if (value == 0 || value > uint256(type(int256).max)) revert BadAnswer();
        answer = int256(value);
        updatedAt = p.publishTime; startedAt = p.publishTime;
        roundId = uint80(p.publishTime); answeredInRound = roundId;
    }
}
