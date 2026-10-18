// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "./ElpidaV3MigrationAdapter.sol";
import "./ElpidaLockedPool.sol";
interface IV2TaxFactory {function getPair(address,address) external view returns(address);function createPair(address,address) external returns(address);}
interface IV2TaxPair {function getReserves() external view returns(uint112,uint112,uint32);function totalSupply() external view returns(uint256);function mint(address) external returns(uint256);function skim(address) external;function sync() external;}
interface ITaxCurveDomain {function token() external view returns(address);function migrationAdapter() external view returns(address);function creatorRewardVault() external view returns(address);}

/// @notice Separate V2 path for transfer-tax tokens; liquidity is minted to a
/// permanent dead address. V2 LP fees compound in the locked position, not claims.
contract ElpidaV2TaxMigrationAdapter {
    address public immutable dexFactory;
    address public immutable weth;
    address public immutable usdc;
    bool private entered;
    constructor(address factory_,address wrapped_,address quote_){
        require(factory_.code.length>0&&wrapped_.code.length>0&&(quote_==address(0)||quote_.code.length>0),"DEX config");
        dexFactory=factory_;weth=wrapped_;usdc=quote_;
    }
    function migrate(ElpidaV3MigrationAdapter.Request calldata r) external payable returns(ElpidaV3MigrationAdapter.Result memory result){
        require(!entered,"reentrancy");entered=true;
        require(ITaxCurveDomain(msg.sender).token()==r.token&&ITaxCurveDomain(msg.sender).migrationAdapter()==address(this),"curve domain");
        require(r.quote==address(0)||r.quote==usdc,"quote asset");
        address q=r.quote==address(0)?weth:r.quote;
        address pair=IV2TaxFactory(dexFactory).getPair(r.token,q);
        if(pair==address(0))pair=IV2TaxFactory(dexFactory).createPair(r.token,q);
        // Empty pre-created pairs are safe. Existing funded pairs need explicit
        // handling; never silently accept an attacker's opening price.
        require(IV2TaxPair(pair).totalSupply()==0,"funded pool conflict");
        // With LP supply zero, clearing unsolicited donations cannot withdraw
        // anyone's LP principal. Tax tokens reject third-party pre-seeding.
        IV2TaxPair(pair).skim(address(0xdead));IV2TaxPair(pair).sync();
        require(IERC20Minimal(r.token).transferFrom(msg.sender,pair,r.tokenAmount),"token funding");
        if(r.quote==address(0)){
            require(msg.value==r.quoteAmount,"native value");IWrappedMigrationAsset(weth).deposit{value:r.quoteAmount}();
            require(IERC20Minimal(weth).transfer(pair,r.quoteAmount),"wrapped funding");
        }else{
            require(msg.value==0,"native value");require(IERC20Minimal(q).transferFrom(msg.sender,pair,r.quoteAmount),"quote funding");
        }
        // Synced quote-only donations have no LP owner; keep them as extra locked backing.
        require(IERC20Minimal(r.token).balanceOf(pair)==r.tokenAmount&&IERC20Minimal(q).balanceOf(pair)>=r.quoteAmount,"pool balance conflict");
        require(IV2TaxPair(pair).mint(address(0xdead))>0,"LP mint");
        result=ElpidaV3MigrationAdapter.Result(pair,address(0xdead),ITaxCurveDomain(msg.sender).creatorRewardVault(),0,r.tokenAmount,r.quoteAmount);
        entered=false;
    }
}
