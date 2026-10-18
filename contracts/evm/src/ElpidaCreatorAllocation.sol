// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "./ElpidaFeeSplitter.sol";

/// @notice Immutable creator-side allocation. Native/quote curve fees and post-DEX
/// token taxes are tracked by asset; a failed recipient cannot block others.
contract ElpidaCreatorAllocation {
    address[] public recipients;
    uint16[] public shares;
    mapping(address=>uint256) public accounted;
    mapping(address=>mapping(address=>uint256)) public claimable;
    bool private entered;
    event Allocated(address indexed asset,uint256 amount);
    event Claimed(address indexed asset,address indexed recipient,uint256 amount);
    modifier guarded(){require(!entered,"reentrancy");entered=true;_;entered=false;}
    constructor(address[] memory recipients_,uint16[] memory shares_){
        require(recipients_.length>0&&recipients_.length<=8&&recipients_.length==shares_.length,"allocation count");
        uint256 total;
        for(uint256 i;i<recipients_.length;i++){
            require(recipients_[i]!=address(0)&&shares_[i]>0,"allocation recipient/share");
            for(uint256 j;j<i;j++)require(recipients_[i]!=recipients_[j],"duplicate recipient");
            total+=shares_[i];
        }
        require(total==10000,"allocation total");recipients=recipients_;shares=shares_;
    }
    receive() external payable {}
    function sync(address asset) public guarded {_sync(asset);}
    function _sync(address asset) private {
        uint256 held=asset==address(0)?address(this).balance:IFeeToken(asset).balanceOf(address(this));
        require(held>=accounted[asset],"unsupported asset");
        uint256 amount=held-accounted[asset];if(amount==0)return;
        accounted[asset]=held;uint256 assigned;
        for(uint256 i;i<recipients.length;i++){
            uint256 part=i+1==recipients.length?amount-assigned:amount*shares[i]/10000;
            assigned+=part;claimable[asset][recipients[i]]+=part;
        }
        emit Allocated(asset,amount);
    }
    function claim(address asset,address recipient) external guarded returns(bool ok){
        _sync(asset);uint256 amount=claimable[asset][recipient];if(amount==0)return true;
        claimable[asset][recipient]=0;accounted[asset]-=amount;
        if(asset==address(0))(ok,)=recipient.call{value:amount}("");
        else {try IFeeToken(asset).transfer(recipient,amount) returns(bool sent){ok=sent;}catch{ok=false;}}
        if(!ok){claimable[asset][recipient]=amount;accounted[asset]+=amount;}
        else emit Claimed(asset,recipient,amount);
    }
}
