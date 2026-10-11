// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IFeeToken {
    function balanceOf(address) external view returns (uint256);
    function transfer(address,uint256) external returns (bool);
    function transferFrom(address,address,uint256) external returns (bool);
    function approve(address,uint256) external returns (bool);
}

/// @notice Prototype fee-only escrow. LP principal must live in a separate permanent locker.
/// @dev Immutable beneficiaries; no owner, upgrades or arbitrary withdrawal. NOT AUDITED.
contract ElpidaFeeSplitter {
    address public immutable treasury;
    address public immutable creator;
    mapping(address => mapping(address => uint256)) public claimable;
    bool private entered;
    event FeesFunded(address indexed asset,uint256 amount,uint256 protocolShare,uint256 creatorShare);
    event FeesClaimed(address indexed asset,address indexed recipient,uint256 amount);
    modifier guarded() { require(!entered,"reentrancy"); entered=true; _; entered=false; }
    constructor(address treasury_,address creator_) {
        require(treasury_!=address(0) && creator_!=address(0),"zero beneficiary");
        treasury=treasury_;creator=creator_;
    }
    function depositToken(address asset,uint256 amount) external guarded {
        require(asset!=address(0) && amount>0,"asset/amount");
        uint256 beforeBalance=IFeeToken(asset).balanceOf(address(this));
        require(IFeeToken(asset).transferFrom(msg.sender,address(this),amount),"funding failed");
        require(IFeeToken(asset).balanceOf(address(this))-beforeBalance==amount,"unsupported token");
        _credit(asset,amount);
    }
    function depositNative() external payable guarded { require(msg.value>0,"amount");_credit(address(0),msg.value); }
    function _credit(address asset,uint256 amount) private {
        uint256 p=amount/2; uint256 c=amount-p;
        claimable[asset][treasury]+=p;claimable[asset][creator]+=c;
        emit FeesFunded(asset,amount,p,c);
    }
    // Anyone can trigger payout, but only to the fixed beneficiary. A failing beneficiary cannot block the other.
    function claim(address asset,address recipient) external guarded {
        require(recipient==treasury || recipient==creator,"beneficiary");
        uint256 amount=claimable[asset][recipient];claimable[asset][recipient]=0;
        if(amount==0)return;
        if(asset==address(0)){(bool ok,)=recipient.call{value:amount}("");require(ok,"native payout");}
        else require(IFeeToken(asset).transfer(recipient,amount),"token payout");
        emit FeesClaimed(asset,recipient,amount);
    }
}
