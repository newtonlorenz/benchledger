import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { Alert, AppState, KeyboardAvoidingView, Linking, Platform, Switch, Text, View, useColorScheme } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { DarkTheme, DefaultTheme, NavigationContainer, type LinkingOptions } from "@react-navigation/native";
import * as SystemUI from "expo-system-ui";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { createNativeBottomTabNavigator } from "@react-navigation/bottom-tabs/unstable";
import Ionicons from "@expo/vector-icons/Ionicons";
import { StatusBar } from "expo-status-bar";
import { fetch } from "expo/fetch";
import { BenchLedgerClient, type Fetcher } from "./client";
import { credentialStore, pairLinkMemory } from "./credentials";
import { createDemoClient } from "./demo";
import { ErrorBoundary } from "./error-boundary";
import { foregroundThrottle } from "./foreground";
import { linking, parsePairLink } from "./links";
import type { InventoryRoutes, ProjectRoutes } from "./navigation";
import { SessionContext } from "./session";
import { SessionController } from "./session-controller";
import { EditItemScreen, InventoryScreen, ItemScreen, NewProjectScreen, ProjectScreen, ProjectsScreen, ServerScreen } from "./screens";
import { Action, AdaptiveScrollView as ScrollView, BrandMark, Colours, Copy, Field, Icon, Loading, Notice, styles, useColours } from "./ui";

// Foreground revalidation is throttled so quick app switches do not hammer a home server.
const FOREGROUND_REVALIDATE_MS = 30_000;

const InventoryStack = createNativeStackNavigator<InventoryRoutes>();
const ProjectsStack = createNativeStackNavigator<ProjectRoutes>();
const ServerStack = createNativeStackNavigator();
const Tabs = createBottomTabNavigator();
const NativeTabs = createNativeBottomTabNavigator();
function useStackOptions() {
  const c = useColours();
  return { headerTintColor: c.accent, headerShadowVisible: false, headerBackButtonDisplayMode: "minimal" as const,
    headerTitleStyle: { color: c.text }, headerLargeTitleStyle: { color: c.text },
    // An opaque custom bar background hides large titles on current UIKit.
    headerStyle: Platform.OS === "ios" ? undefined : { backgroundColor: c.background }, contentStyle: { backgroundColor: c.background } };
}
const largeHeader = { headerLargeTitleEnabled: true, headerLargeTitleShadowVisible: false };
function InventoryNavigator() {
  return <InventoryStack.Navigator screenOptions={useStackOptions()}><InventoryStack.Screen name="Inventory" component={InventoryScreen} options={largeHeader} />
    <InventoryStack.Screen name="Item" component={ItemScreen} options={{ title: "Item details" }} />
    <InventoryStack.Screen name="EditItem" component={EditItemScreen} options={{ title: "Edit details" }} /></InventoryStack.Navigator>;
}
function ProjectsNavigator() {
  return <ProjectsStack.Navigator screenOptions={useStackOptions()}><ProjectsStack.Screen name="Projects" component={ProjectsScreen} options={largeHeader} />
    <ProjectsStack.Screen name="Project" component={ProjectScreen} options={{ title: "Project details" }} />
    <ProjectsStack.Screen name="NewProject" component={NewProjectScreen} options={{ title: "New project" }} /></ProjectsStack.Navigator>;
}
function ServerNavigator() {
  return <ServerStack.Navigator screenOptions={useStackOptions()}><ServerStack.Screen name="Workspace" component={ServerScreen} options={{ ...largeHeader, title: "Server" }} /></ServerStack.Navigator>;
}
function Workspace() {
  const c = useColours();
  // UIKit owns the tab material, contrast and accessibility adaptations on
  // iOS 27. Do not paint a simulated glass surface over the native tab bar.
  if (Platform.OS === "ios") return <NativeTabs.Navigator screenOptions={{ headerShown: false, tabBarActiveTintColor: c.accent }}>
    <NativeTabs.Screen name="Stock" component={InventoryNavigator} options={{ title: "Inventory", tabBarIcon: { type: "sfSymbol", name: "shippingbox" } }} />
    <NativeTabs.Screen name="Builds" component={ProjectsNavigator} options={{ title: "Projects", tabBarIcon: { type: "sfSymbol", name: "folder" } }} />
    <NativeTabs.Screen name="Server" component={ServerNavigator} options={{ title: "Server", tabBarIcon: { type: "sfSymbol", name: "externaldrive.connected.to.line.below" } }} />
  </NativeTabs.Navigator>;
  return <Tabs.Navigator screenOptions={({ route }) => ({
    tabBarActiveTintColor: c.accent, tabBarInactiveTintColor: c.muted,
    tabBarStyle: { backgroundColor: c.surface, borderTopColor: c.line },
    tabBarHideOnKeyboard: true,
    tabBarIcon: ({ color, size }) => <Ionicons name={route.name === "Stock" ? "cube-outline" : route.name === "Builds" ? "folder-open-outline" : "server-outline"} size={size} color={color} />
  })}>
    <Tabs.Screen name="Stock" component={InventoryNavigator} options={{ title: "Inventory", headerShown: false }} />
    <Tabs.Screen name="Builds" component={ProjectsNavigator} options={{ title: "Projects", headerShown: false }} />
    <Tabs.Screen name="Server" component={ServerNavigator} options={{ headerShown: false }} />
  </Tabs.Navigator>;
}

function createController() {
  return new SessionController({
    store: credentialStore,
    createClient: (connection) => new BenchLedgerClient(connection, fetch as Fetcher),
    createDemo: createDemoClient
  });
}

function MobileApp() {
  const c = useColours(); const dark = useColorScheme() === "dark";
  const controller = useMemo(createController, []);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const pendingPair = useRef<string | undefined>(undefined);

  useEffect(() => {
    void controller.restore();
    return () => controller.dispose();
  }, [controller]);

  // Keep the root view behind native transitions in step with light/dark mode.
  useEffect(() => { void SystemUI.setBackgroundColorAsync(c.background).catch(() => undefined); }, [c.background]);

  // Pairing links only prefill the form. Never log the URL: it may carry a token.
  useEffect(() => {
    const receive = (url: string | null) => { if (url && parsePairLink(url)) { pendingPair.current = url; applyPair(); } };
    // Android can return the same initial URL on later cold starts; a pairing
    // link already consumed must not prefill a token again after sign-out.
    void Linking.getInitialURL().then(async (url) => {
      if (url && parsePairLink(url) && !await pairLinkMemory.claimInitial(url)) return;
      receive(url);
    }).catch(() => undefined);
    const subscription = Linking.addEventListener("url", ({ url }) => {
      if (parsePairLink(url)) void pairLinkMemory.remember(url);
      receive(url);
    });
    return () => subscription.remove();
  }, [controller]);
  useEffect(() => { applyPair(); }, [state.phase]);
  function applyPair() {
    const url = pendingPair.current;
    if (!url || controller.state.phase === "restoring") return;
    pendingPair.current = undefined;
    const draft = parsePairLink(url);
    if (draft && !controller.prefill(draft)) {
      Alert.alert("Already connected", "Disconnect in the Server tab before pairing this phone with another server.");
    }
  }

  // Revalidate visible screens, or retry an unreachable server, on return to the foreground.
  useEffect(() => {
    const should = foregroundThrottle(FOREGROUND_REVALIDATE_MS);
    let previous: string = AppState.currentState;
    const subscription = AppState.addEventListener("change", (next) => {
      const resume = should(previous, next); previous = next;
      const current = controller.state;
      if (!resume || current.phase !== "workspace") return;
      if (current.reachability === "offline") void controller.retry();
      else current.cache.revalidate();
    });
    return () => subscription.remove();
  }, [controller]);

  const base = dark ? DarkTheme : DefaultTheme;
  const theme = { ...base, colors: { ...base.colors, primary: c.accent, background: c.background, card: c.surface, text: c.text, border: c.line } };
  if (state.phase === "workspace") {
    const { phase: _phase, client, ...rest } = state;
    const value = { ...rest, client: client as BenchLedgerClient, disconnect: () => controller.disconnect(), retry: () => controller.retry() };
    return <SessionContext.Provider value={value}>
      <NavigationContainer theme={theme} linking={linking as unknown as LinkingOptions<ReactNavigation.RootParamList>}><StatusBar style={dark ? "light" : "dark"} /><Workspace /></NavigationContainer>
    </SessionContext.Provider>;
  }
  const signedOut = state.phase === "signed_out" ? state : undefined;
  const draft = signedOut?.draft ?? { server: "", token: "", allowLocalHttp: false };
  const busy = signedOut?.busy ?? false;
  const setDraft = (next: typeof draft) => controller.setDraft(next);
  return <SafeAreaView style={[styles.screen, { backgroundColor: c.background }]}>
    <StatusBar style={dark ? "light" : "dark"} />
    {!signedOut ? <Loading /> : <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <ScrollView keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive" contentContainerStyle={styles.connection}>
        <View style={styles.hero}><BrandMark />
          <Text accessibilityRole="header" style={[styles.connectionTitle, { color: c.text }]}>Your bench,{"\n"}wherever you are.</Text>
          <Copy secondary>Connect your BenchLedger server to bring your inventory and projects with you.</Copy>
        </View>
        {signedOut.notice && <Notice message={signedOut.notice} />}
        <View style={[styles.connectionFields, { backgroundColor: c.surface }]}>
        <Field label="Server address" placeholder="https://benchledger.example.com" value={draft.server} onChangeText={(server) => setDraft({ ...draft, server })}
          autoCapitalize="none" autoCorrect={false} keyboardType="url" textContentType="URL" maxLength={2048} editable={!busy} style={{ backgroundColor: c.background }} />
        <Field label="API token" placeholder="Paste your scoped token" value={draft.token} onChangeText={(token) => setDraft({ ...draft, token })}
          autoCapitalize="none" autoCorrect={false} secureTextEntry textContentType="none" autoComplete="off" importantForAutofill="no" maxLength={4096} editable={!busy} style={{ backgroundColor: c.background }} />
        <Text style={[styles.small, { color: c.muted }]}>Use an API token from your server administrator. Your browser password is different.</Text>
        </View>
        <View style={styles.switchRow}><View style={styles.flex}><Text style={[styles.copy, { color: c.text, fontWeight: "500" }]}>Allow local HTTP</Text><Text style={[styles.small, { color: c.muted }]}>For a trusted local network only.</Text></View>
          <Switch accessibilityLabel="Allow local HTTP" value={draft.allowLocalHttp} disabled={busy} onValueChange={(allowLocalHttp) => setDraft({ ...draft, allowLocalHttp })} trackColor={{ true: c.accent }} />
        </View>
        {draft.allowLocalHttp && <Notice message="HTTP sends your token and workspace data without encryption. Public server addresses still require HTTPS." />}
        {signedOut.error ? <Notice error message={signedOut.error} /> : null}
        <Action label={busy ? "Connecting…" : "Connect to server"} icon="arrow-forward" busy={busy} disabled={!draft.server.trim() || !draft.token.trim()} onPress={() => { void controller.connect(draft); }} />
        <Action quiet label="Explore a sample workspace" icon="eye-outline" disabled={busy} onPress={() => { void controller.openDemo(); }} />
        <View style={styles.secureNote}><Icon name="lock-closed-outline" size={16} color={c.muted} /><Text style={[styles.small, styles.flex, { color: c.muted }]}>Your token stays in secure device storage. No BenchLedger cloud account needed.</Text></View>
      </ScrollView>
    </KeyboardAvoidingView>}
  </SafeAreaView>;
}

function Recovery({ reset }: { reset(): void }) {
  const c = useColours();
  return <SafeAreaView style={[styles.screen, { backgroundColor: c.background }]}>
    <View style={styles.connection}>
      <Copy title>Something went wrong</Copy>
      <Copy secondary>This screen hit an unexpected problem. Your saved connection and server data are unchanged.</Copy>
      <Action icon="refresh" label="Try again" onPress={reset} />
    </View>
  </SafeAreaView>;
}

export default function App() {
  return <SafeAreaProvider><Colours>
    <ErrorBoundary fallback={(reset) => <Recovery reset={reset} />}><MobileApp /></ErrorBoundary>
  </Colours></SafeAreaProvider>;
}
