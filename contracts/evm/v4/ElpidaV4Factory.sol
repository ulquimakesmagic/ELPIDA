// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "../src/ElpidaToken.sol";
import "../src/ElpidaUsdPricing.sol";
import {ElpidaV4Hook} from "./ElpidaV4Hook.sol";

interface IV4Quote {
    function decimals() external view returns (uint8);
    function balanceOf(address) external view returns (uint256);
    function transferFrom(address, address, uint256) external returns (bool);
}

/// @notice Model 11 launchpad (PROTOTYPE, NOT AUDITED, local chain only): creates a token and its locked-from-launch
/// Uniswap v4 pool in one transaction. Same commercial terms as Model 10: an oracle-priced $10 launch fee (or 10 USDC),
/// a $startFdvUsd starting FDV for native pairs, team-approved ERC-20 quote templates (USDC), partner tiers and
/// token details published only in the launch transaction.
contract ElpidaV4Factory is ElpidaUsdPricing {
    uint256 public constant TOKEN_SUPPLY = 1_000_000_000 ether;
    uint256 public constant MODEL_VERSION = 11;
    uint256 public constant METADATA_VERSION = 1;
    address public immutable treasury;
    /// Starting FDV in whole US dollars: 5000 on mainnet, 50 on test-sized testnet deployments.
    uint256 public immutable startFdvUsd;
    bool private immutable metadataRequired;
    ElpidaV4Hook public hook;
    mapping(address => bool) public isElpidaToken;
    mapping(address => string) public tokenMetadataURI;
    /// Virtual quote (raw units) for each team-approved ERC-20 quote; 0 means not approved. Set once per asset.
    mapping(address => uint256) public approvedQuotes;
    /// Early-partner tiers, as in Model 10: 1000 or 2000 of the base fee buys back and burns, from Elpida's half.
    struct Partner { uint16 buybackBps; uint64 expiresAt; }
    mapping(address => Partner) public partners;
    uint64 public constant MAX_PARTNER_WINDOW = 180 days;
    uint256 public launches;
    bool private entered;

    event HookSet(address indexed hook);
    event QuoteApproved(address indexed asset, uint256 virtualQuote);
    event PartnerSet(address indexed creator, uint16 buybackBps, uint64 expiresAt);
    event MetadataPublished(address indexed token, string uri);
    event Launched(address indexed creator, address indexed token, address indexed quote, uint256 firstBuy, uint256 bought);

    constructor(address treasury_, uint256 startFdvUsd_, bool requireMetadata_) {
        require(treasury_ != address(0), "zero address");
        require(startFdvUsd_ >= 1 && startFdvUsd_ <= 1_000_000, "start FDV");
        treasury = treasury_; startFdvUsd = startFdvUsd_; metadataRequired = requireMetadata_;
    }

    function pricingOwner() internal view override returns (address) { return treasury; }
    function requiresMetadata() public view returns (bool) { return metadataRequired; }

    /// Native virtual reserve for a new launch: the starting FDV times 10/9, at the current oracle price (Model 10).
    function nativeVirtualQuote() public view override returns (uint256) {
        return Math.mulDiv(nativeUsdAmount(startFdvUsd), 10, 9, Math.Rounding.Ceil);
    }

    /// Once: the hook is deployed separately at an address whose low bits carry its permissions.
    function setHook(address hook_) external {
        require(msg.sender == treasury && address(hook) == address(0), "owner only/set");
        require(ElpidaV4Hook(hook_).factory() == address(this) && ElpidaV4Hook(hook_).protocolTreasury() == treasury, "hook");
        hook = ElpidaV4Hook(hook_); emit HookSet(hook_);
    }

    /// Team-approved, immutable ERC-20 quote (USDC): its virtual quote in raw units, from the starting FDV.
    function approveQuote(address asset, uint256 virtualQuote_) external {
        require(msg.sender == treasury && asset.code.length > 0 && virtualQuote_ > 0 && approvedQuotes[asset] == 0, "quote approval");
        uint8 d = IV4Quote(asset).decimals(); require(d >= 6 && d <= 18, "quote decimals");
        approvedQuotes[asset] = virtualQuote_; emit QuoteApproved(asset, virtualQuote_);
    }

    function setPartner(address creator, uint16 buybackBps, uint64 expiresAt) external {
        require(msg.sender == treasury, "owner only");
        require(creator != address(0), "partner");
        if (buybackBps == 0) { require(expiresAt == 0, "partner terms"); delete partners[creator]; }
        else {
            require((buybackBps == 1000 || buybackBps == 2000) && expiresAt > block.timestamp && expiresAt <= block.timestamp + MAX_PARTNER_WINDOW, "partner terms");
            partners[creator] = Partner(buybackBps, expiresAt);
        }
        emit PartnerSet(creator, buybackBps, expiresAt);
    }

    function buybackShareOf(address creator) public view returns (uint16) {
        Partner memory p = partners[creator];
        return p.buybackBps != 0 && block.timestamp <= p.expiresAt ? p.buybackBps : 0;
    }

    /// Native pair, fee in the native coin: msg.value = launch fee + first buy (any excess is refunded).
    function launch(string calldata name_, string calldata symbol_, uint256 firstBuy, uint256 minOut, address reward) external payable returns (address token, uint256 bought) {
        return _launch(name_, symbol_, address(0), firstBuy, minOut, reward, "", false);
    }

    /// The general entry, as Model 10's: `asset` 0 for the native coin or an approved quote; `uri` the token details
    /// (ipfs://, required where `requiresMetadata()`); `inUsdc` pays the fee as 10 USDC instead of the native coin.
    function launchWithPayment(string calldata name_, string calldata symbol_, address asset, uint256 firstBuy, uint256 minOut, address reward, string calldata uri, bool inUsdc) external payable returns (address token, uint256 bought) {
        return _launch(name_, symbol_, asset, firstBuy, minOut, reward, uri, inUsdc);
    }

    function _launch(string calldata name_, string calldata symbol_, address asset, uint256 firstBuy, uint256 minOut, address reward, string memory uri, bool inUsdc) private returns (address token, uint256 bought) {
        require(!entered, "reentrancy"); entered = true;
        require(address(hook) != address(0) && reward != address(0), "hook/reward");
        if (bytes(uri).length > 0) _checkUri(uri); else require(!metadataRequired, "metadata required");
        uint256 vq = asset == address(0) ? nativeVirtualQuote() : approvedQuotes[asset];
        require(vq > 0, "quote not approved");
        _chargeLaunchFee(asset == address(0) ? firstBuy : 0, inUsdc);
        token = _deployToken(name_, symbol_, asset);
        if (asset != address(0) && firstBuy > 0) {
            uint256 before = IV4Quote(asset).balanceOf(address(hook));
            require(IV4Quote(asset).transferFrom(msg.sender, address(hook), firstBuy), "first buy");
            require(IV4Quote(asset).balanceOf(address(hook)) - before == firstBuy, "unsupported quote");
        }
        bought = hook.launch{value: asset == address(0) ? firstBuy : 0}(token, asset, reward, msg.sender, vq, buybackShareOf(msg.sender), firstBuy, minOut);
        isElpidaToken[token] = true;
        if (bytes(uri).length > 0) { tokenMetadataURI[token] = uri; emit MetadataPublished(token, uri); }
        emit Launched(msg.sender, token, asset, firstBuy, bought);
        entered = false;
    }

    /// CREATE2 with the first salt that puts the token's address above the quote's, so the quote is always the pool's
    /// currency0 (for the native coin, address 0, any salt does). Expected tries: one or two.
    function _deployToken(string calldata name_, string calldata symbol_, address quote) private returns (address token) {
        bytes memory init = abi.encodePacked(type(ElpidaToken).creationCode, abi.encode(name_, symbol_, TOKEN_SUPPLY, address(hook)));
        bytes32 codeHash = keccak256(init);
        uint256 n = launches++;
        for (uint256 i = 0; i < 256; i++) {
            bytes32 salt = keccak256(abi.encode(msg.sender, n, i));
            address predicted = address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, codeHash)))));
            if (uint160(predicted) <= uint160(quote) || predicted.code.length > 0) continue;
            assembly { token := create2(0, add(init, 0x20), mload(init), salt) }
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

/// @notice Minimal CREATE2 deployer, used to place the hook at a mined address.
contract ElpidaCreate2Deployer {
    event Deployed(address indexed at, bytes32 salt);
    function deploy(bytes calldata initCode, bytes32 salt) external returns (address at) {
        bytes memory code = initCode;
        assembly { at := create2(0, add(code, 0x20), mload(code), salt) }
        require(at != address(0), "create2");
        emit Deployed(at, salt);
    }
}
