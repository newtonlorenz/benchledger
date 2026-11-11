const { getDefaultConfig } = require("expo/metro-config");
const path = require("node:path");

const config = getDefaultConfig(__dirname);
const queryAdapter = path.join(__dirname, "src/query-string.ts");
config.resolver.resolveRequest = (context, moduleName, platform) => {
  // React Navigation 7 imports the old CJS namespace. Keep that API while
  // using the maintained parser, whose malformed-input decoder is bounded.
  if (moduleName === "query-string" && context.originModulePath !== queryAdapter) {
    return { type: "sourceFile", filePath: queryAdapter };
  }
  return context.resolveRequest(context, moduleName, platform);
};
module.exports = config;
