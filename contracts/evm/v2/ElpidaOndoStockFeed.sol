// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IOndoUnderlyingFeed {
    function decimals() external view returns (uint8);
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
}

/// Ondo's SyntheticSharesOracle (Ethereum 0x9BC39DB6…41bE6, BNB Chain 0xF4Fd8a1B…5F15e): shares per token (18 decimals)
/// and whether the token is paused for a corporate action.
interface IOndoSharesOracle {
    function getSValue(address asset) external view returns (uint128 sValue, bool paused);
}

/// @notice The USD price of one Ondo stock token, read like a Chainlink feed (Malik, 13 November: Ondo stocks on every
/// EVM chain). Chainlink publishes feeds for only a few Ondo tokens, but for more underlying shares (BNB Chain: AAPL,
/// TSLA, NVDA…). A token is worth its underlying share price times Ondo's on-chain multiplier (`sValue`, the shares one
/// token represents after reinvested dividends and splits), so this answers price × sValue. While Ondo pauses the token
/// for a corporate action it reverts, so no launch is priced from a multiplier that is about to change. The factory's
/// own checks (a positive, answered and fresh round within the pair's maximum age) apply to the round returned here,
/// which is the underlying feed's round. Nothing here can be changed after deployment.
/// @dev Elpida is not affiliated with Ondo or Chainlink; both are read as public on-chain data.
contract ElpidaOndoStockFeed {
    uint256 public constant VERSION = 1;
    IOndoUnderlyingFeed public immutable underlying;
    IOndoSharesOracle public immutable sharesOracle;
    address public immutable token;
    uint8 public immutable decimals;
    string public description;

    error OndoPaused();
    error BadAnswer();

    constructor(address underlying_, address sharesOracle_, address token_, string memory description_) {
        require(underlying_.code.length > 0 && sharesOracle_.code.length > 0 && token_.code.length > 0, "contracts");
        require(bytes(description_).length > 0 && bytes(description_).length <= 96, "description");
        uint8 d = IOndoUnderlyingFeed(underlying_).decimals();
        require(d <= 18, "feed decimals");
        (uint128 s,) = IOndoSharesOracle(sharesOracle_).getSValue(token_);
        require(s > 0, "sValue");
        underlying = IOndoUnderlyingFeed(underlying_); sharesOracle = IOndoSharesOracle(sharesOracle_); token = token_; decimals = d;
        description = description_;
    }

    function latestRoundData() external view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound) {
        (roundId, answer, startedAt, updatedAt, answeredInRound) = underlying.latestRoundData();
        (uint128 s, bool paused) = sharesOracle.getSValue(token);
        if (paused) revert OndoPaused();
        if (answer <= 0 || s == 0) revert BadAnswer();
        answer = int256(uint256(answer) * uint256(s) / 1e18);
        if (answer <= 0) revert BadAnswer();
    }
}
