export default {
  networks: {
    localTest: {
      type: 'edr-simulated',
      chainType: 'l1',
      hardfork: 'shanghai',
      throwOnTransactionFailures: false,
    },
    // Model 11 prototype only: Uniswap v4 needs cancun (transient storage). Everything deployed today stays on shanghai.
    localCancun: {
      type: 'edr-simulated',
      chainType: 'l1',
      hardfork: 'cancun',
      throwOnTransactionFailures: false,
    },
  },
};
