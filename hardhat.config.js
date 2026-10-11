export default {
  networks: {
    localTest: {
      type: 'edr-simulated',
      chainType: 'l1',
      hardfork: 'shanghai',
      throwOnTransactionFailures: false,
    },
  },
};
