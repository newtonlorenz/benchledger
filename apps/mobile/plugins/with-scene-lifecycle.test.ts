import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const { adoptScenes } = createRequire(import.meta.url)("./with-scene-lifecycle.cjs") as { adoptScenes(source: string): string };
const template = `@main
class AppDelegate: ExpoAppDelegate {
  var window: UIWindow?
  var reactNativeFactory: RCTReactNativeFactory?
  public override func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
    reactNativeFactory = factory

#if os(iOS) || os(tvOS)
    window = UIWindow(frame: UIScreen.main.bounds)
    factory.startReactNative(
      withModuleName: "main",
      in: window,
      launchOptions: launchOptions)
#endif

    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }
}`;

describe("iOS scene life cycle plugin", () => {
  it("lets the Expo scene delegate own the window and start React Native", () => {
    const result = adoptScenes(template);
    expect(result).toContain("class AppDelegate: ExpoAppDelegate, ExpoReactNativeFactoryProvider {");
    expect(result).not.toContain("UIWindow(frame:");
    expect(result).not.toContain("startReactNative");
    expect(result).toContain("return super.application(application, didFinishLaunchingWithOptions: launchOptions)");
    expect(adoptScenes(result)).toBe(result);
  });
  it("fails loudly when the template changes", () => {
    expect(() => adoptScenes("class AppDelegate: SomethingElse {}")).toThrow(/no longer matches/u);
  });
});
