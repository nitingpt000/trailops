const path = require('path');
const {getDefaultConfig, mergeConfig} = require('@react-native/metro-config');

const contracts = path.resolve(__dirname, '../../packages/contracts');

/** Shared contracts live outside the app; Metro watches them and resolves the package name. */
const config = {
  watchFolders: [contracts],
  resolver: {
    extraNodeModules: {'@trailops/contracts': contracts},
    nodeModulesPaths: [path.resolve(__dirname, 'node_modules')],
  },
};

module.exports = mergeConfig(getDefaultConfig(__dirname), config);
