const path = require('path');

module.exports = {
  preset: 'react-native',
  moduleNameMapper: {
    '^@trailops/contracts$': path.resolve(__dirname, '../../packages/contracts/src/index.ts'),
  },
  transformIgnorePatterns: ['node_modules/(?!(@react-native|react-native|@nozbe)/)'],
  // Shared contracts live outside this package; resolve their helpers from the app's node_modules.
  modulePaths: [path.resolve(__dirname, 'node_modules')],
  testPathIgnorePatterns: ['/node_modules/', '/android/', '/ios/'],
};
