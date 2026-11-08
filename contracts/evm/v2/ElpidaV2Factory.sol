// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "../src/ElpidaUsdPricing.sol";
import {ElpidaV2Token} from "./ElpidaV2Token.sol";
import {ElpidaV2Hook} from "./ElpidaV2Hook.sol";

interface IV2Quote {
    function decimals() external view returns (uint8);
    function balanceOf(address) external view returns (uint256);
    function transferFrom(address, address, uint256) external returns (bool);
}

/// @notice ELPIDA V2.0 launchpad (PROTOTYPE, NOT AUDITED, local chain only). Creates a burnable token and its
/// locked-from-launch Uniswap v4 pool in one transaction. Terms (docs/V2_0_AUDIT.md):
///  - $10 launch fee, paid in the native coin at the oracle price or as 10 USDC (decision C7, 8 November 2026);
///  - $20,000 starting FDV (`startFdvUsd`), so the native virtual quote is that x 5/4; graduation at 5x ($100,000);
///  - each creator picks the token's fee (hook.minFeeBps()..4%, 1.25% suggested); it never changes;
///  - optional creator first buy, capped by the hook at 3% of supply;
///  - no partner tiers; token details published only in the launch transaction.
contract ElpidaV2Factory is ElpidaUsdPricing {
    uint256 public constant TOKEN_SUPPLY = 1_000_000_000 ether;
    uint256 public constant LAUNCHPAD_VERSION = 2;
    uint256 public constant METADATA_VERSION = 1;
    address public immutable treasury;
    /// Starting FDV in whole US dollars: 20000 for V2.0 terms; smaller on test-sized testnet deployments.
    uint256 public immutable startFdvUsd;
    bool private immutable metadataRequired;
    ElpidaV2Hook public hook;
    mapping(address => bool) public isElpidaToken;
    mapping(address => string) public tokenMetadataURI;
    /// Virtual quote (raw units) for each team-approved ERC-20 quote; 0 means not approved. Set once per asset.
    mapping(address => uint256) public approvedQuotes;
    uint256 public launches;
    bool private entered;

    struct Terms { address asset; uint16 feeBps; uint256 firstBuy; uint256 minOut; address reward; bool inUsdc; }

    event HookSet(address indexed hook);
    event QuoteApproved(address indexed asset, uint256 virtualQuote);
    event MetadataPublished(address indexed token, string uri);
    event Launched(address indexed creator, address indexed token, address indexed quote, uint256 feeBps, uint256 firstBuy, uint256 bought);

    constructor(address treasury_, uint256 startFdvUsd_, bool requireMetadata_) {
        require(treasury_ != address(0), "zero address");
        require(startFdvUsd_ >= 1 && startFdvUsd_ <= 1_000_000, "start FDV");
        treasury = treasury_; startFdvUsd = startFdvUsd_; metadataRequired = requireMetadata_;
    }

    function pricingOwner() internal view override returns (address) { return treasury; }
    function requiresMetadata() public view returns (bool) { return metadataRequired; }

    /// Native virtual reserve for a new launch: the starting FDV x 5/4 at the current oracle price, rounded up (never
    /// a cheaper start than the stated FDV).
    function nativeVirtualQuote() public view override returns (uint256) {
        return Math.mulDiv(nativeUsdAmount(startFdvUsd), 5, 4, Math.Rounding.Ceil);
    }

    function setHook(address hook_) external {
        require(msg.sender == treasury && address(hook) == address(0), "owner only/set");
        require(ElpidaV2Hook(hook_).factory() == address(this) && ElpidaV2Hook(hook_).protocolTreasury() == treasury, "hook");
        hook = ElpidaV2Hook(hook_); emit HookSet(hook_);
    }

    function approveQuote(address asset, uint256 virtualQuote_) external {
        require(msg.sender == treasury && asset.code.length > 0 && virtualQuote_ > 0 && approvedQuotes[asset] == 0, "quote approval");
        uint8 d = IV2Quote(asset).decimals(); require(d >= 6 && d <= 18, "quote decimals");
        approvedQuotes[asset] = virtualQuote_; emit QuoteApproved(asset, virtualQuote_);
    }

    /// Native pair, fee in the native coin: msg.value = launch fee + first buy (any excess is refunded).
    function launch(string calldata name_, string calldata symbol_, uint16 feeBps, uint256 firstBuy, uint256 minOut, address reward) external payable returns (address token, uint256 bought) {
        return _launch(name_, symbol_, Terms(address(0), feeBps, firstBuy, minOut, reward, false), "");
    }

    /// `asset` 0 for the native coin or an approved quote; `uri` the token details (ipfs://, required where
    /// `requiresMetadata()`); `inUsdc` pays the fee as 10 USDC instead of the native coin.
    function launchWithPayment(string calldata name_, string calldata symbol_, address asset, uint16 feeBps, uint256 firstBuy, uint256 minOut, address reward, string calldata uri, bool inUsdc) external payable returns (address token, uint256 bought) {
        return _launch(name_, symbol_, Terms(asset, feeBps, firstBuy, minOut, reward, inUsdc), uri);
    }

    function _launch(string calldata name_, string calldata symbol_, Terms memory t, string memory uri) private returns (address token, uint256 bought) {
        require(!entered, "reentrancy"); entered = true;
        require(address(hook) != address(0) && t.reward != address(0), "hook/reward");
        if (bytes(uri).length > 0) _checkUri(uri); else require(!metadataRequired, "metadata required");
        uint256 vq = t.asset == address(0) ? nativeVirtualQuote() : approvedQuotes[t.asset];
        require(vq > 0, "quote not approved");
        _chargeLaunchFee(t.asset == address(0) ? t.firstBuy : 0, t.inUsdc);
        token = _deployToken(name_, symbol_, t.asset);
        if (t.asset != address(0) && t.firstBuy > 0) _fundFirstBuy(t.asset, t.firstBuy);
        bought = hook.launch{value: t.asset == address(0) ? t.firstBuy : 0}(token, t.asset, t.reward, msg.sender, vq, t.feeBps, t.firstBuy, t.minOut);
        isElpidaToken[token] = true;
        if (bytes(uri).length > 0) { tokenMetadataURI[token] = uri; emit MetadataPublished(token, uri); }
        emit Launched(msg.sender, token, t.asset, t.feeBps, t.firstBuy, bought);
        entered = false;
    }

    function _fundFirstBuy(address asset, uint256 amount) private {
        uint256 before = IV2Quote(asset).balanceOf(address(hook));
        require(IV2Quote(asset).transferFrom(msg.sender, address(hook), amount), "first buy");
        require(IV2Quote(asset).balanceOf(address(hook)) - before == amount, "unsupported quote");
    }

    /// CREATE2 with the first salt that puts the token's address above the quote's (the quote is always currency0).
    function _deployToken(string calldata name_, string calldata symbol_, address quote) private returns (address token) {
        bytes memory init = abi.encodePacked(type(ElpidaV2Token).creationCode, abi.encode(name_, symbol_, TOKEN_SUPPLY, address(hook)));
        bytes32 codeHash = keccak256(init);
        uint256 n = launches++;
        for (uint256 i = 0; i < 256; i++) {
            bytes32 salt = keccak256(abi.encode(msg.sender, n, i));
            address predicted = address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, codeHash)))));
            if (uint160(predicted) <= uint160(quote) || predicted.code.length > 0) continue;
            assembly ("memory-safe") { token := create2(0, add(init, 0x20), mload(init), salt) }
            require(token == predicted, "token deploy");
            return token;
        }
        revert("token address");
    }

    function _checkUri(string memory uri) private pure {
        bytes memory value = bytes(uri); require(value.length >= 16 && value.length <= 128, "metadata URI length");
        require(value[0] == 'i' && value[1] == 'p' && value[2] == 'f' && value[3] == 's' && value[4] == ':' && value[5] == '/' && value[6] == '/', "IPFS URI required");
    }
}
