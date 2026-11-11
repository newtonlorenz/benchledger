const { withAppDelegate, withInfoPlist } = require("expo/config-plugins");

// iOS 27 (apps built with Xcode 27) asserts at launch unless the app adopts the
// UIScene life cycle. Expo SDK 57 ships `ExpoAppSceneDelegate`, which creates the
// window per scene and forwards scene events to the app delegate, but the
// generated AppDelegate still starts React Native into its own window. This
// plugin makes the AppDelegate a factory provider, lets the scene delegate own
// the window, and registers the scene configuration. Remove it once the Expo
// prebuild template adopts scenes itself.
const providerDeclaration = "class AppDelegate: ExpoAppDelegate, ExpoReactNativeFactoryProvider {";
const appWindowStart = /#if os\(iOS\) \|\| os\(tvOS\)\s*window = UIWindow\(frame: UIScreen\.main\.bounds\)\s*factory\.startReactNative\([\s\S]*?\)\s*#endif\s*/u;

function adoptScenes(source) {
  if (source.includes(providerDeclaration)) return source;
  if (!source.includes("class AppDelegate: ExpoAppDelegate {") || !appWindowStart.test(source)) {
    throw new Error("with-scene-lifecycle: AppDelegate.swift no longer matches the expected Expo template; review the scene adoption.");
  }
  return source
    .replace("class AppDelegate: ExpoAppDelegate {", providerDeclaration)
    .replace(appWindowStart, "    // ExpoAppSceneDelegate creates the window and starts React Native per scene.\n\n");
}

module.exports = function withSceneLifecycle(config) {
  config = withAppDelegate(config, (config) => {
    if (config.modResults.language !== "swift") throw new Error("with-scene-lifecycle expects a Swift AppDelegate");
    config.modResults.contents = adoptScenes(config.modResults.contents);
    return config;
  });
  return withInfoPlist(config, (config) => {
    config.modResults.UIApplicationSceneManifest = {
      UIApplicationSupportsMultipleScenes: false,
      UISceneConfigurations: {
        UIWindowSceneSessionRoleApplication: [{ UISceneConfigurationName: "Default Configuration", UISceneDelegateClassName: "EXExpoAppSceneDelegate" }]
      }
    };
    return config;
  });
};
module.exports.adoptScenes = adoptScenes;
