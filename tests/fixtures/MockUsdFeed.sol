// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
contract MockUsdFeed {
    uint8 public constant decimals=8;
    string public description="ETH / USD";
    address public immutable owner=msg.sender;
    int256 public answer;
    uint256 public updatedAt;
    uint80 public roundId;
    uint80 public answeredInRound;
    constructor(int256 initial){set(initial,block.timestamp,1,1);}
    function set(int256 value,uint256 timestamp,uint80 round,uint80 answered) public {
        require(msg.sender==owner,"owner");answer=value;updatedAt=timestamp;roundId=round;answeredInRound=answered;
    }
    /// BNB Chain rehearsals read "BNB / USD" (13 November).
    function setDescription(string calldata value) external { require(msg.sender==owner,"owner"); description=value; }
    function latestRoundData() external view returns(uint80,int256,uint256,uint256,uint80){return(roundId,answer,updatedAt,updatedAt,answeredInRound);}
}
