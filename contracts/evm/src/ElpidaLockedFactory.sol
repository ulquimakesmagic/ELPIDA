// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "./ElpidaToken.sol";
import "./ElpidaLockedPool.sol";

interface ILockedQuoteDecimals { function decimals() external view returns (uint8); }

/// @notice Test prototype: seed a permanently locked pool and execute creator first buy atomically.
contract ElpidaLockedFactory {
    IERC20Minimal public immutable usdc;
    address public immutable treasury;
    uint8 public immutable quoteDecimals;
    uint256 public immutable LAUNCH_FEE;
    uint256 public constant TOKEN_SUPPLY = 1_000_000_000 ether;
    uint256 public constant MODEL_VERSION = 2;
    mapping(address => bool) public isElpidaToken;
    bool private entered;
    event Launched(address indexed creator, address indexed token, address indexed pool, uint256 firstBuy, uint256 seedQuote);
    constructor(address quote_, address treasury_) {
        require(quote_ != address(0) && treasury_ != address(0), "zero address");
        uint8 d = ILockedQuoteDecimals(quote_).decimals();
        require(d >= 6 && d <= 18, "quote decimals");
        usdc = IERC20Minimal(quote_); treasury = treasury_; quoteDecimals = d; LAUNCH_FEE = 10 * uint256(10) ** d;
    }
    function launch(string calldata name_, string calldata symbol_, uint256 seedQuote, uint256 firstBuy, uint256 minOut, address reward)
        external returns (address tokenAddress, address poolAddress)
    {
        require(!entered, "reentrancy"); entered = true;
        require(seedQuote > 0, "liquidity required");
        require(firstBuy > 0, "mandatory first buy");
        require(reward != address(0), "reward vault required");
        uint256 funding = LAUNCH_FEE + seedQuote + firstBuy;
        uint256 beforeBalance = usdc.balanceOf(address(this));
        require(usdc.transferFrom(msg.sender, address(this), funding), "funding failed");
        require(usdc.balanceOf(address(this)) - beforeBalance == funding, "unsupported quote");
        require(usdc.transfer(treasury, LAUNCH_FEE), "launch fee failed");
        ElpidaToken created = new ElpidaToken(name_, symbol_, TOKEN_SUPPLY, address(this));
        ElpidaLockedPool pool = new ElpidaLockedPool(address(usdc), address(created), address(this), treasury, reward, TOKEN_SUPPLY);
        require(created.transfer(address(pool), TOKEN_SUPPLY), "token seed failed");
        require(usdc.transfer(address(pool), seedQuote), "quote seed failed");
        pool.initialize(seedQuote);
        require(usdc.approve(address(pool), firstBuy), "approval failed");
        pool.initialBuy(msg.sender, firstBuy, minOut);
        require(usdc.approve(address(pool), 0), "approval cleanup failed");
        tokenAddress = address(created); poolAddress = address(pool); isElpidaToken[tokenAddress] = true;
        emit Launched(msg.sender, tokenAddress, poolAddress, firstBuy, seedQuote);
        entered = false;
    }
}
