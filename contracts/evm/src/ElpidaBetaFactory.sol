// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "./ElpidaToken.sol";
import "./ElpidaBetaCurve.sol";
interface ILaunchDecimals { function decimals() external view returns (uint8); }
contract ElpidaBetaFactory {
    IERC20Minimal public immutable usdc;
    address public immutable treasury;
    uint8 public immutable quoteDecimals;
    uint256 public immutable LAUNCH_FEE;
    uint256 public immutable VIRTUAL_QUOTE;
    uint256 public immutable NATIVE_VIRTUAL_QUOTE;
    uint256 public constant VIRTUAL_TOKEN = uint256(800_000_000 ether) * 800_000_000 ether / (600_000_000 ether);
    uint256 public constant TOKEN_SUPPLY = 1_000_000_000 ether;
    uint256 public constant MODEL_VERSION = 4;
    bool private entered;
    mapping(address => bool) public isElpidaToken;
    event Launched(address indexed creator,address indexed token,address indexed curve,uint256 firstBuy,bool nativePair);
    constructor(address usdc_,address treasury_,uint256 nativeVirtualQuote_) {
        require(usdc_ != address(0) && treasury_ != address(0), "zero address");
        uint8 d = ILaunchDecimals(usdc_).decimals(); require(d >= 6 && d <= 18, "quote decimals");
        usdc = IERC20Minimal(usdc_); treasury = treasury_; quoteDecimals = d;
        require(nativeVirtualQuote_ > 0, "native template");
        LAUNCH_FEE = 10 * uint256(10)**d; VIRTUAL_QUOTE = 5000 * uint256(10)**d * VIRTUAL_TOKEN / TOKEN_SUPPLY;
        NATIVE_VIRTUAL_QUOTE = nativeVirtualQuote_;
    }
    function launch(string calldata name_,string calldata symbol_,bool nativePair,uint256 firstBuy,uint256 minOut,address reward) external payable returns (address,address) {
        require(!entered, "reentrancy"); entered = true;
        require(firstBuy > 0 && reward != address(0), "buy/reward required");
        require(msg.value == (nativePair ? firstBuy : 0), "native value");
        uint256 funding = LAUNCH_FEE + (nativePair ? 0 : firstBuy);
        uint256 beforeBalance = usdc.balanceOf(address(this));
        require(usdc.transferFrom(msg.sender,address(this),funding), "funding failed");
        require(usdc.balanceOf(address(this)) - beforeBalance == funding, "unsupported quote");
        require(usdc.transfer(treasury,LAUNCH_FEE), "launch fee");
        ElpidaToken t = new ElpidaToken(name_,symbol_,TOKEN_SUPPLY,address(this));
        ElpidaBetaCurve c = new ElpidaBetaCurve(nativePair ? address(0) : address(usdc),address(t),address(this),treasury,reward,nativePair ? NATIVE_VIRTUAL_QUOTE : VIRTUAL_QUOTE,VIRTUAL_TOKEN);
        require(t.transfer(address(c),TOKEN_SUPPLY), "token seed");
        if (nativePair) c.initialBuy{value:firstBuy}(msg.sender,firstBuy,minOut);
        else {
            require(usdc.approve(address(c),firstBuy), "approval"); c.initialBuy(msg.sender,firstBuy,minOut);
            require(usdc.approve(address(c),0), "approval cleanup");
        }
        isElpidaToken[address(t)] = true; emit Launched(msg.sender,address(t),address(c),firstBuy,nativePair);
        entered = false; return (address(t),address(c));
    }
}
