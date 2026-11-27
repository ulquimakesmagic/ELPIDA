// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IUsdFeed} from "../src/ElpidaUsdPricing.sol";

interface IElysiumInbox {
    function createRetryableTicket(
        address to,
        uint256 l2CallValue,
        uint256 maxSubmissionCost,
        address excessFeeRefundAddress,
        address callValueRefundAddress,
        uint256 gasLimit,
        uint256 maxFeePerGas,
        bytes calldata data
    ) external payable returns (uint256);
}

struct HypeUsdRound {
    uint80 id;
    int256 answer;
    uint256 startedAt;
    uint256 updatedAt;
    uint80 answeredInRound;
}

library HypeUsdValidation {
    uint8 internal constant DECIMALS = 18;
    uint256 internal constant MAX_AGE = 1 days;

    function fresh(HypeUsdRound memory round) internal view returns (bool) {
        return round.id != 0 && round.answer > 0 && round.answeredInRound >= round.id
            && round.startedAt != 0 && round.startedAt <= round.updatedAt
            && round.updatedAt <= block.timestamp && block.timestamp - round.updatedAt <= MAX_AGE;
    }
}

/// @notice On Elysium, accepts rounds sent by the immutable HyperEVM publisher through the canonical Inbox.
contract ElpidaElysiumHypeUsdFeed is IUsdFeed {
    uint8 public constant decimals = HypeUsdValidation.DECIMALS;
    string public constant description = "HYPE / USD";
    uint160 private constant ALIAS_OFFSET = uint160(0x1111000000000000000000000000000000001111);

    address public immutable parentPublisher;
    address public immutable aliasedPublisher;
    HypeUsdRound private latest;

    event RoundReceived(uint80 indexed roundId, int256 answer, uint256 updatedAt);
    error BadConfiguration();
    error UnauthorizedPublisher();
    error InvalidRound();
    error EarlierRound();

    constructor(address parentPublisher_) {
        if (parentPublisher_ == address(0)) revert BadConfiguration();
        parentPublisher = parentPublisher_;
        unchecked { aliasedPublisher = address(uint160(parentPublisher_) + ALIAS_OFFSET); }
    }

    function receiveRound(HypeUsdRound calldata round) external {
        if (msg.sender != aliasedPublisher) revert UnauthorizedPublisher();
        if (!HypeUsdValidation.fresh(round)) revert InvalidRound();
        if (round.id <= latest.id || round.updatedAt < latest.updatedAt) revert EarlierRound();
        latest = round;
        emit RoundReceived(round.id, round.answer, round.updatedAt);
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        HypeUsdRound memory round = latest;
        if (!HypeUsdValidation.fresh(round)) revert InvalidRound();
        return (round.id, round.answer, round.startedAt, round.updatedAt, round.answeredInRound);
    }
}

/// @notice On HyperEVM, any caller can pay to deliver the current round from the pinned Chainlink proxy.
contract ElpidaHypeUsdPublisher {
    IUsdFeed public immutable source;
    IElysiumInbox public immutable inbox;
    address public immutable receiver;

    event RoundQueued(uint80 indexed roundId, uint256 indexed ticketId, uint256 updatedAt);
    error BadConfiguration();
    error InvalidRound();

    constructor(address source_, address inbox_, address receiver_) {
        if (source_.code.length == 0 || inbox_.code.length == 0 || receiver_ == address(0)) {
            revert BadConfiguration();
        }
        source = IUsdFeed(source_);
        inbox = IElysiumInbox(inbox_);
        receiver = receiver_;
        if (source.decimals() != HypeUsdValidation.DECIMALS) revert BadConfiguration();
    }

    function relay(uint256 maxSubmissionCost, uint256 gasLimit, uint256 maxFeePerGas)
        external payable returns (uint256 ticketId)
    {
        HypeUsdRound memory round;
        (round.id, round.answer, round.startedAt, round.updatedAt, round.answeredInRound) = source.latestRoundData();
        if (source.decimals() != HypeUsdValidation.DECIMALS || !HypeUsdValidation.fresh(round)) revert InvalidRound();

        ticketId = inbox.createRetryableTicket{value: msg.value}(
            receiver, 0, maxSubmissionCost, msg.sender, msg.sender, gasLimit, maxFeePerGas,
            abi.encodeCall(ElpidaElysiumHypeUsdFeed.receiveRound, (round))
        );
        emit RoundQueued(round.id, ticketId, round.updatedAt);
    }
}
