// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "./ElpidaToken.sol";
import "./ElpidaCurve.sol";

interface IERC20Decimals {
    function decimals() external view returns (uint8);
}

/// @notice Factory prototype: launch fee + mandatory first buy in a single transaction.
/// @dev Dollar amounts are scaled to the quote token's decimals (6 on Circle USDC, 18 on BNB Chain's bridged USDC).
contract ElpidaFactory {
    IERC20Minimal public immutable usdc;
    address public immutable treasury;
    uint8 public immutable quoteDecimals;
    uint256 public immutable LAUNCH_FEE; // 10 USDC in quote units
    uint256 public constant TOKEN_SUPPLY = 1_000_000_000 ether;
    // These parameters are placeholders, NOT production-calibrated token economics.
    uint256 public immutable VIRTUAL_QUOTE; // 30,000 USDC in quote units
    uint256 public constant VIRTUAL_TOKEN = 1_500_000_000 ether;
    mapping(address => bool) public isElpidaToken;
    event Launched(address indexed creator, address indexed token, address indexed curve, uint256 firstBuy);

    constructor(address usdc_, address treasury_) {
        require(usdc_ != address(0) && treasury_ != address(0), "zero address");
        uint8 d = IERC20Decimals(usdc_).decimals();
        require(d >= 6 && d <= 18, "quote decimals");
        usdc = IERC20Minimal(usdc_); treasury = treasury_; quoteDecimals = d;
        LAUNCH_FEE = 10 * uint256(10) ** d;
        VIRTUAL_QUOTE = 30_000 * uint256(10) ** d;
    }

    function launch(string calldata name_, string calldata symbol_, uint256 firstBuy, uint256 minTokensOut, address creatorRewardVault)
        external returns (address tokenAddress, address curveAddress)
    {
        require(firstBuy > 0, "mandatory first buy");
        require(creatorRewardVault != address(0), "reward vault required");
        // User approves this factory for LAUNCH_FEE + the first buy.
        require(usdc.transferFrom(msg.sender, address(this), LAUNCH_FEE + firstBuy), "funding failed");
        require(usdc.transfer(treasury, LAUNCH_FEE), "launch fee failed");
        ElpidaToken created = new ElpidaToken(name_, symbol_, TOKEN_SUPPLY, address(this));
        ElpidaCurve curve = new ElpidaCurve(address(usdc), address(created), address(this), treasury, creatorRewardVault, VIRTUAL_QUOTE, VIRTUAL_TOKEN);
        require(created.transfer(address(curve), TOKEN_SUPPLY), "seed curve failed");
        require(usdc.approve(address(curve), firstBuy), "approval failed");
        curve.initialBuy(msg.sender, firstBuy, minTokensOut);
        require(usdc.approve(address(curve), 0), "approval cleanup failed");
        tokenAddress = address(created); curveAddress = address(curve);
        isElpidaToken[tokenAddress] = true;
        emit Launched(msg.sender, tokenAddress, curveAddress, firstBuy);
    }
}
