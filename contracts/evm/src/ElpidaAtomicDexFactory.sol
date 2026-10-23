// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "./ElpidaDexFactory.sol";

/// @notice New-launch factory: final purchase and locked V3 migration are one transaction.
/// Failure rolls the purchase back. Every launch must publish its token details (ipfs:// URI) in the launch
/// transaction; there is no way to add them later. Existing deployed factories/curves are unchanged.
contract ElpidaAtomicDexFactory is ElpidaDexFactory {
    constructor(address treasury_,address adapter_,uint256 startFdvUsd_,uint256 graduationGrace_)
        ElpidaDexFactory(treasury_,adapter_,startFdvUsd_,graduationGrace_) {}
    function automaticGraduation() public pure override returns(bool){return true;}
    function requiresMetadata() public pure override returns(bool){return true;}
}
