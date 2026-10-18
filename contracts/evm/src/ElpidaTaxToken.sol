// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
interface ITaxBoundCurve {function migrationAdapter() external view returns(address);}
interface ITaxBoundAdapter {function dexFactory() external view returns(address);}

/// @notice Fixed 0..10% buy/sell tax; no admin rate changes, blacklist or mint.
/// Tax applies only to the canonical V2 pair. Ordinary transfers are untaxed.
/// Collected tax is paid in this token, 30% treasury / 70% creator allocation.
contract ElpidaTaxToken is ERC20 {
    address public immutable factory;
    address public immutable treasury;
    address public immutable allocation;
    uint16 public immutable buyTaxBps;
    uint16 public immutable sellTaxBps;
    address public curve;
    address public pair;
    address public migrationAdapter;
    address public dexFactory;
    event TaxPaid(address indexed trader,bool buy,uint256 amount,uint256 protocolAmount);
    constructor(string memory name_,string memory symbol_,address factory_,address treasury_,address allocation_,uint16 buy_,uint16 sell_) ERC20(name_,symbol_){
        require(buy_<=1000&&sell_<=1000,"tax exceeds 10%");
        require(factory_!=address(0)&&treasury_!=address(0)&&allocation_!=address(0),"tax recipients");
        factory=factory_;treasury=treasury_;allocation=allocation_;buyTaxBps=buy_;sellTaxBps=sell_;
        _mint(factory_,1_000_000_000 ether);
    }
    function bindCurve(address curve_) external {
        require(msg.sender==factory&&curve==address(0)&&curve_!=address(0),"curve binding");curve=curve_;
        migrationAdapter=ITaxBoundCurve(curve_).migrationAdapter();dexFactory=ITaxBoundAdapter(migrationAdapter).dexFactory();
    }
    function activatePair(address pair_) external {require(msg.sender==curve&&pair==address(0)&&pair_.code.length>0,"pair binding");pair=pair_;}
    function _update(address from,address to,uint256 amount) internal override {
        // Prevent a third party from pre-seeding the canonical V2 pool and
        // obtaining a withdrawable LP share before permanent graduation.
        if(pair==address(0)&&curve!=address(0)&&msg.sender!=migrationAdapter&&to.code.length>0){
            (bool ok,bytes memory data)=to.staticcall{gas:5000}(abi.encodeWithSignature("factory()"));
            if(ok&&data.length==32)require(address(uint160(uint256(bytes32(data))))!=dexFactory,"pool not activated");
        }
        // Funding liquidity occurs before activation. No tax exemptions can be added later.
        if(pair!=address(0)&&from!=address(0)&&to!=address(0)&&(from==pair||to==pair)){
            bool buy=from==pair;uint256 tax=amount*(buy?buyTaxBps:sellTaxBps)/10000;
            if(tax>0){
                uint256 protocol=tax*3000/10000;
                super._update(from,treasury,protocol);super._update(from,allocation,tax-protocol);
                emit TaxPaid(buy?to:from,buy,tax,protocol);amount-=tax;
            }
        }
        super._update(from,to,amount);
    }
}
