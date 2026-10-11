// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "./ElpidaToken.sol";
import "./ElpidaBetaCurve.sol";

/// @notice Basic launchpad (no DEX graduation), native pricing. NOT AUDITED.
/// @dev Every launch is paired with the chain's native coin and pays its creation fee in that coin.
/// The treasury (owner) sets the fee and the curve's starting virtual reserve with `setPricing`; new
/// values apply to later launches only, because each curve stores its own virtual reserve.
contract ElpidaBetaFactory {
    address public immutable treasury;
    uint256 public launchFee;
    uint256 public nativeVirtualQuote;
    uint256 public constant VIRTUAL_TOKEN = uint256(800_000_000 ether) * 800_000_000 ether / (600_000_000 ether);
    uint256 public constant TOKEN_SUPPLY = 1_000_000_000 ether;
    uint256 public constant MODEL_VERSION = 6;
    bool private entered;
    mapping(address => bool) public isElpidaToken;
    event Launched(address indexed creator,address indexed token,address indexed curve,uint256 firstBuy,bool nativePair);
    event PricingSet(uint256 launchFee,uint256 nativeVirtualQuote);
    constructor(address treasury_,uint256 launchFee_,uint256 nativeVirtualQuote_) {
        require(treasury_ != address(0), "zero address");
        treasury = treasury_; _setPricing(launchFee_,nativeVirtualQuote_);
    }
    /// Treasury only: creation fee (wei) and starting virtual native reserve (wei) for future launches.
    function setPricing(uint256 launchFee_,uint256 nativeVirtualQuote_) external {
        require(msg.sender == treasury, "owner only"); _setPricing(launchFee_,nativeVirtualQuote_);
    }
    function _setPricing(uint256 launchFee_,uint256 nativeVirtualQuote_) private {
        require(nativeVirtualQuote_ > 0, "native template");
        launchFee = launchFee_; nativeVirtualQuote = nativeVirtualQuote_; emit PricingSet(launchFee_,nativeVirtualQuote_);
    }
    /// msg.value must be exactly the creation fee plus the first buy, so a fee change in between reverts.
    function launch(string calldata name_,string calldata symbol_,uint256 firstBuy,uint256 minOut,address reward) external payable returns (address,address) {
        require(!entered, "reentrancy"); entered = true;
        require(firstBuy > 0 && reward != address(0), "buy/reward required");
        uint256 fee = launchFee;
        require(msg.value == fee + firstBuy, "native value");
        if (fee > 0) { (bool ok,) = treasury.call{value:fee}(""); require(ok, "launch fee"); }
        ElpidaToken t = new ElpidaToken(name_,symbol_,TOKEN_SUPPLY,address(this));
        ElpidaBetaCurve c = new ElpidaBetaCurve(address(0),address(t),address(this),treasury,reward,nativeVirtualQuote,VIRTUAL_TOKEN);
        require(t.transfer(address(c),TOKEN_SUPPLY), "token seed");
        c.initialBuy{value:firstBuy}(msg.sender,firstBuy,minOut);
        isElpidaToken[address(t)] = true; emit Launched(msg.sender,address(t),address(c),firstBuy,true);
        entered = false; return (address(t),address(c));
    }
}
