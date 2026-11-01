// The shared package lives outside this app and outside an npm workspace (the web app needs React 18,
// Expo needs React 19 — one workspace would install duplicate Reacts). Point Metro at it explicitly.
const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
const sharedDir = path.resolve(__dirname, '../../packages/shared');

config.watchFolders = [...(config.watchFolders ?? []), sharedDir];
config.resolver.extraNodeModules = {
  ...(config.resolver.extraNodeModules ?? {}),
  '@transitlink/shared': sharedDir,
};
// Shared code's own dependencies (socket.io-client) resolve from this app if not found next to it.
config.resolver.nodeModulesPaths = [
  path.resolve(__dirname, 'node_modules'),
  ...(config.resolver.nodeModulesPaths ?? []),
];

module.exports = config;
