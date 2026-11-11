import { memo, type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Alert, FlatList, Linking, Platform, Pressable, RefreshControl, Text, View, useWindowDimensions, type ListRenderItem } from "react-native";
import { useNavigation, usePreventRemove } from "@react-navigation/native";
import type { SearchBarCommands } from "react-native-screens";
import type { NavigationAction } from "@react-navigation/native";
import type { NativeStackNavigationOptions, NativeStackScreenProps } from "@react-navigation/native-stack";
import * as Crypto from "expo-crypto";
import type { InventoryItem, Project } from "@benchledger/api-contract";
import { SEARCH_MAX_LENGTH, canWriteWorkspace } from "./client";
import { ClientError } from "./connection";
import { useItemEditor } from "./item-editor";
import type { InventoryRoutes, ProjectRoutes } from "./navigation";
import { ItemPhotos, RowThumbnail } from "./photos";
import { useSession } from "./session";
import { inventoryAccessibilityLabel, stockActions, stockReceivingPolicyText, stockSummary, syncedLabel } from "./presentation";
import { routeScan } from "./scan";
import { ScannerModal } from "./scanner";
import { useQueueEntries, useStockQueue } from "./stock-context";
import { useLastSynced, usePage, useRemote } from "./use-remote";
import { Action, AdaptiveScrollView as ScrollView, Copy, Empty, Evidence, Fact, Field, Group, Icon, Loading, Notice, Section, StatusBadge, SymbolTile, humanise, itemIcon, quantity, styles, useColours } from "./ui";

function useSearch(navigation: { setOptions(options: Partial<NativeStackNavigationOptions>): void }, placeholder: string) {
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const bar = useRef<SearchBarCommands>(null);
  useEffect(() => { const timer = setTimeout(() => setQuery(search), 250); return () => clearTimeout(timer); }, [search]);
  useLayoutEffect(() => {
    if (Platform.OS === "ios") navigation.setOptions({ headerSearchBarOptions: {
      ref: bar, placeholder, hideWhenScrolling: false, obscureBackground: false, placement: "stacked",
      onChangeText: (event) => setSearch(event.nativeEvent.text.slice(0, SEARCH_MAX_LENGTH)), onCancelButtonPress: () => setSearch("")
    } });
  }, [navigation, placeholder]);
  /** Fill the search (native bar included), e.g. from a scanned barcode. */
  const fill = useCallback((text: string) => { bar.current?.setText(text); setSearch(text); }, []);
  return { search, setSearch, query, fill };
}
/** Workspace reachability, shown at the top of each screen while it matters. */
export function WorkspaceStatus() {
  const { reachability, message, warning, provisional, retry, demo, cache } = useSession(); const c = useColours();
  const synced = useLastSynced(cache);
  if (demo) return null;
  return <>
    {reachability === "offline" && <View style={{ gap: 8 }}>
      <Text accessibilityRole="header" style={[styles.rowTitle, { color: c.text }]}>{syncedLabel(synced)} · offline</Text>
      <Notice error message={`Can't reach your workspace. ${message} ${cache.persistent ? "Showing what was saved on this device." : "Anything already loaded stays visible."}`} />
      <Action quiet icon="refresh" label="Retry" onPress={() => { void retry(); }} />
    </View>}
    {reachability === "rejected" && <View style={{ gap: 8 }}>
      <Notice error message={`The server refused this connection. ${message}`} />
      <Action quiet icon="refresh" label="Check again" onPress={() => { void retry(); }} />
    </View>}
    {reachability === "checking" && provisional && <Text accessibilityLiveRegion="polite" style={[styles.small, { color: c.muted }]}>Connecting to your workspace…</Text>}
    {warning && <Notice message={warning} />}
    <PendingBanner />
  </>;
}
/** Stock changes recorded on this phone that the server has not confirmed. */
function PendingBanner() {
  const queue = useStockQueue(); const entries = useQueueEntries(queue); const navigation = useNavigation(); const c = useColours();
  const waiting = entries.filter((e) => e.status === "pending" || e.status === "sending").length;
  const blocked = entries.filter((e) => e.status === "conflict" || e.status === "failed").length;
  if (!waiting && !blocked) return null;
  const label = [waiting ? `${waiting} stock ${waiting === 1 ? "change" : "changes"} waiting to send` : "", blocked ? `${blocked} need${blocked === 1 ? "s" : ""} your decision` : ""].filter(Boolean).join(" · ");
  return <Pressable accessibilityRole="button" accessibilityLabel={`${label}. Review`} onPress={() => (navigation as unknown as { navigate(tab: string, params: object): void }).navigate("Server", { screen: "PendingChanges", initial: false })}
    style={({ pressed }) => [styles.notice, { flexDirection: "row", alignItems: "center", gap: 10, backgroundColor: blocked ? c.errorBg : c.statusBg, opacity: pressed ? 0.72 : 1 }]}>
    <Icon name={blocked ? "alert-circle-outline" : "cloud-upload-outline"} size={20} color={blocked ? c.error : c.status} />
    <Text style={[styles.small, styles.flex, { color: blocked ? c.error : c.status }]}>{label}</Text>
    <Icon name="chevron-forward" size={16} color={blocked ? c.error : c.status} />
  </Pressable>;
}
function Updating({ visible }: { visible: boolean }) {
  const c = useColours();
  return visible ? <Text accessibilityLiveRegion="polite" style={[styles.small, { color: c.muted }]}>Updating…</Text> : null;
}
function Footer({ busy, error, hasMore, more, refresh, count }: {
  busy: boolean; error: string; hasMore: boolean; more(): void; refresh(): void; count: number
}) {
  const c = useColours();
  // Pages load automatically at the end of the list; a failed page waits for an explicit retry.
  return <View style={styles.footer}>
    {error ? <><Notice error message={count ? `${error} Showing previously loaded records.` : error} /><Action quiet label="Try again" onPress={count > 0 && hasMore ? more : refresh} disabled={busy} /></> : null}
    {hasMore && busy && !error && count > 0 && <ActivityIndicator accessibilityLabel="Loading more" color={c.accent} />}
    {count > 0 && <Text style={[styles.small, { color: c.muted }]}>{count} {count === 1 ? "record" : "records"} loaded{hasMore ? "" : " · end of list"}</Text>}
  </View>;
}
const keyById = (item: { id: string }) => item.id;
/** Show the pull spinner only for a user's pull, not for background revalidation. */
function usePullRefresh(refresh: () => Promise<unknown>) {
  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = useCallback(() => { setRefreshing(true); void refresh().finally(() => setRefreshing(false)); }, [refresh]);
  return { refreshing, onRefresh };
}
function Separator() {
  const c = useColours();
  return <View style={{ marginHorizontal: 20, backgroundColor: c.surface }}><View style={{ height: 0.5, marginLeft: 78, backgroundColor: c.line }} /></View>;
}

const InventoryRow = memo(function InventoryRow({ item, first, last, onOpen, thumbnail }: { item: InventoryItem; first: boolean; last: boolean; onOpen(id: string): void; thumbnail: ReactNode }) {
  const c = useColours();
  return <Pressable accessibilityRole="button" accessibilityLabel={inventoryAccessibilityLabel(item)} onPress={() => onOpen(item.id)}
    style={({ pressed }) => [styles.row, first && styles.firstRow, last && styles.lastRow, { backgroundColor: pressed ? c.accentSoft : c.surface }]}>
    {thumbnail}
    <View style={styles.rowBody}>
      <Text style={[styles.rowTitle, { color: c.text }]}>{item.name}</Text>
      <Text style={[styles.rowMeta, { color: c.muted }]}>{stockSummary(item)}{item.location ? ` · ${item.location}` : ""}</Text>
      <Evidence item={item} />
    </View><Icon name="chevron-forward" size={16} color={c.muted} />
  </Pressable>;
});

export function InventoryScreen({ navigation }: NativeStackScreenProps<InventoryRoutes, "Inventory">) {
  const { client, demo, cache } = useSession(); const c = useColours();
  const { fontScale } = useWindowDimensions();
  const { search, setSearch, query, fill } = useSearch(navigation, "Search inventory");
  const [scanning, setScanning] = useState(false);
  useLayoutEffect(() => {
    if (Platform.OS === "ios") navigation.setOptions({ unstable_headerRightItems: () => [{ type: "button", label: "Scan", icon: { type: "sfSymbol", name: "qrcode.viewfinder" }, onPress: () => setScanning(true) }] });
  }, [navigation]);
  const scanned = useCallback((data: string) => {
    const result = routeScan(data, { signedIn: true });
    if (result.kind === "item") navigation.navigate("Item", { id: result.id });
    else if (result.kind === "project") navigation.getParent()?.navigate("Builds", { screen: "Project", params: { id: result.id }, initial: false });
    else if (result.kind === "search") fill(result.text);
    else if (result.kind === "ignored") Alert.alert("Can't use this code", result.reason);
  }, [navigation, fill]);
  const scope = useMemo(() => ({ cache, key: `inventory?q=${query}` }), [cache, query]);
  const { page, error, busy, updating, more, endReached, hasMore, refresh } = usePage(useCallback((cursor?: string) => client.inventory(query, cursor), [client, query]), scope);
  const pull = usePullRefresh(refresh);
  const open = useCallback((id: string) => navigation.navigate("Item", { id }), [navigation]);
  const count = page?.data.length ?? 0;
  const renderItem = useCallback<ListRenderItem<InventoryItem>>(({ item, index }) =>
    <InventoryRow item={item} first={index === 0} last={index === count - 1} onOpen={open} thumbnail={<RowThumbnail client={client} cache={cache} item={item} fallback={<SymbolTile name={itemIcon(item.kind)} />} />} />, [count, open, client, cache]);
  return <><ScannerModal visible={scanning} title="Scan a label" hint="Point at a BenchLedger item label, or a product barcode to search." onClose={() => setScanning(false)} onScan={scanned} />
  <FlatList<InventoryItem> key={fontScale} style={{ backgroundColor: c.background }} contentInsetAdjustmentBehavior="automatic"
    data={page?.data ?? []} keyExtractor={keyById} keyboardDismissMode="on-drag" renderItem={renderItem}
    onEndReached={endReached} onEndReachedThreshold={0.5}
    keyboardShouldPersistTaps="handled" refreshControl={<RefreshControl {...pull} tintColor={c.accent} />}
    ListHeaderComponent={<View style={styles.search}><WorkspaceStatus /><Copy secondary>Parts, tools and materials. All in one place.</Copy>
      {demo && <Copy secondary>Sample workspace · Read only</Copy>}
      {Platform.OS !== "ios" && <><Field label="Search inventory" placeholder="Name, material, part or location" value={search} onChangeText={setSearch} autoCorrect={false} maxLength={SEARCH_MAX_LENGTH} clearButtonMode="while-editing" />
        <Action quiet icon="qr-code-outline" label="Scan a label" onPress={() => setScanning(true)} /></>}
      <Updating visible={updating} />
    </View>}
    ItemSeparatorComponent={Separator}
    ListEmptyComponent={busy || (!page && !error) ? <Loading /> : !error ? <Empty title={query ? "No matching items" : "No inventory yet"} message={query ? "Try a different name or material." : "Add your first items in the BenchLedger web app. They will appear here when you refresh."} /> : null}
    ListFooterComponent={<Footer {...{ error, busy, more, refresh, hasMore, count }} />} /></>;
}

export function ItemScreen({ route, navigation }: NativeStackScreenProps<InventoryRoutes, "Item">) {
  const { client, session, cache, provisional, demo } = useSession(); const c = useColours(); const { fontScale } = useWindowDimensions();
  // Counts may be recorded before a cold-start session is confirmed: they stay on
  // the phone and are only sent once the server confirms the token's access.
  const canRecordStock = !demo && (canWriteWorkspace(session) || provisional);
  const unsent = useQueueEntries(useStockQueue()).filter((e) => e.itemId === route.params.id && e.status !== "sent").length;
  const scope = useMemo(() => ({ cache, key: `item/${route.params.id}` }), [cache, route.params.id]);
  const { data: item, busy, updating, error, refresh } = useRemote(useCallback(() => client.item(route.params.id), [client, route.params.id]), scope);
  const pull = usePullRefresh(refresh);
  const actions = item ? stockActions(item) : undefined;
  return <ScrollView style={{ backgroundColor: c.background }} contentContainerStyle={styles.content} contentInsetAdjustmentBehavior="automatic"
    refreshControl={<RefreshControl {...pull} tintColor={c.accent} />}>
    <WorkspaceStatus /><Updating visible={updating} />
    {error && <><Notice error message={item ? `${error} These are previously loaded details.` : error} /><Action quiet label="Refresh item" onPress={refresh} disabled={busy} /></>}
    {busy && !item && <Loading />}
    {item && <><View style={styles.hero}><SymbolTile name={itemIcon(item.kind)} large /><Copy title>{item.name}</Copy><Evidence item={item} />{item.description && <Copy secondary>{item.description}</Copy>}</View>
      <Section title="Stock"><View style={[styles.stockRow, fontScale > 1.3 && { flexDirection: "column" }]}>
        <View style={styles.stockColumn}><Text style={[styles.small, { color: c.muted }]}>Recorded quantity</Text><Text style={[styles.stockNumber, { color: c.text }]}>{quantity(item.quantity, item.unit)}</Text></View>
        <View style={styles.stockColumn}><Text style={[styles.small, { color: c.muted }]}>Available quantity</Text><Text style={[styles.stockNumber, { color: c.text }]}>{quantity(item.availableQuantity, item.unit)}</Text></View>
      </View><Text style={[styles.small, { color: c.muted }]}>{actions?.assumed
        ? "This counts as in stock because of your workspace's stock setting. Count it to record that you received it."
        : "Availability follows the server record. Check evidence and compatibility for your build."}</Text>
        {unsent > 0 && <Text style={[styles.small, { color: c.status }]}>{unsent} stock {unsent === 1 ? "change" : "changes"} recorded on this phone, not yet confirmed by the server.</Text>}</Section>
      {canRecordStock && actions && <View style={{ gap: 12 }}>
        <Action label={actions.primary} icon="calculator-outline" onPress={() => navigation.navigate("AdjustStock", { id: item.id, kind: "count" })} />
        {actions.allowReceipt && <Action quiet label="Record received stock" icon="add-circle-outline" onPress={() => navigation.navigate("AdjustStock", { id: item.id, kind: "receipt" })} />}
      </View>}
      <ItemPhotos client={client} cache={cache} itemId={item.id} canWrite={!demo && canWriteWorkspace(session)} />
      <Section title="Item details"><Fact label="Location" value={item.location || "Not recorded"} /><Fact label="Kind" value={humanise(item.kind)} />
        <Fact label="Condition" value={humanise(item.condition ?? "unknown")} />
        {item.manufacturer && <Fact label="Manufacturer" value={item.manufacturer} />}{item.model && <Fact label="Model" value={item.model} />}
        {item.sku && <Fact label="SKU" value={item.sku} />}{item.tags.length > 0 && <Fact label="Tags" value={item.tags.join(", ")} />}</Section>
      <Section title="Evidence">{item.unitCorrectionReason && <Notice message={item.unitCorrectionReason} />}
        <Fact label="Source" value={item.evidence.source || "Not recorded"} /><Fact label="Note" value={item.evidence.note || "No note"} />
        <Fact label="Last updated" value={new Date(item.updatedAt).toLocaleString()} /></Section>
      {canWriteWorkspace(session) && <Action label="Edit item details" icon="create-outline" onPress={() => navigation.navigate("EditItem", { id: item.id })} />}
    </>}
  </ScrollView>;
}

export function ProjectsScreen({ navigation }: NativeStackScreenProps<ProjectRoutes, "Projects">) {
  const { client, session, demo, cache } = useSession(); const c = useColours();
  const { fontScale } = useWindowDimensions();
  const { search, setSearch, query } = useSearch(navigation, "Search projects");
  const scope = useMemo(() => ({ cache, key: `projects?q=${query}` }), [cache, query]);
  const { page, error, busy, updating, more, endReached, hasMore, refresh } = usePage(useCallback((cursor?: string) => client.projects(query, cursor), [client, query]), scope);
  const pull = usePullRefresh(refresh);
  const open = useCallback((id: string) => navigation.navigate("Project", { id }), [navigation]);
  const count = page?.data.length ?? 0;
  const renderItem = useCallback<ListRenderItem<Project>>(({ item, index }) =>
    <ProjectRow project={item} first={index === 0} last={index === count - 1} onOpen={open} />, [count, open]);
  const canCreate = canWriteWorkspace(session);
  useLayoutEffect(() => {
    if (Platform.OS === "ios") navigation.setOptions({ unstable_headerRightItems: () => canCreate ? [{ type: "button", label: "New project", icon: { type: "sfSymbol", name: "plus" }, onPress: () => navigation.navigate("NewProject") }] : [] });
  }, [navigation, canCreate]);
  return <FlatList<Project> key={fontScale} style={{ backgroundColor: c.background }} contentInsetAdjustmentBehavior="automatic"
    data={page?.data ?? []} keyExtractor={keyById} keyboardDismissMode="on-drag" renderItem={renderItem}
    onEndReached={endReached} onEndReachedThreshold={0.5}
    keyboardShouldPersistTaps="handled" refreshControl={<RefreshControl {...pull} tintColor={c.accent} />}
    ListHeaderComponent={<View style={styles.search}><WorkspaceStatus /><Copy secondary>Pick up a build, or start something new.</Copy>
      {demo && <Copy secondary>Sample workspace · Read only</Copy>}
      {Platform.OS !== "ios" && <>{canCreate && <Action label="New project" icon="add" onPress={() => navigation.navigate("NewProject")} />}
        <Field label="Search projects" placeholder="Project name" value={search} onChangeText={setSearch} maxLength={SEARCH_MAX_LENGTH} clearButtonMode="while-editing" /></>}
      {session.projectIds !== undefined && <Copy secondary>Showing projects this token can access.</Copy>}
      <Updating visible={updating} />
    </View>}
    ItemSeparatorComponent={Separator}
    ListEmptyComponent={busy || (!page && !error) ? <Loading /> : !error ? <Empty title={query ? "No matching projects" : "No projects yet"} message={query ? "Try a different project name." : "Start a project to give your next build a place."} /> : null}
    ListFooterComponent={<Footer {...{ error, busy, more, refresh, hasMore, count }} />} />;
}
const ProjectRow = memo(function ProjectRow({ project, first, last, onOpen }: { project: Project; first: boolean; last: boolean; onOpen(id: string): void }) {
  const c = useColours();
  return <Pressable accessibilityRole="button" accessibilityLabel={[project.name, humanise(project.status), project.description].filter(Boolean).join(", ")} onPress={() => onOpen(project.id)}
    style={({ pressed }) => [styles.row, first && styles.firstRow, last && styles.lastRow, { backgroundColor: pressed ? c.accentSoft : c.surface }]}>
    <SymbolTile name="folder-open-outline" /><View style={styles.rowBody}>
      <Text style={[styles.rowTitle, { color: c.text }]}>{project.name}</Text>
      <StatusBadge label={humanise(project.status)} />
      {project.description ? <Text numberOfLines={2} style={[styles.rowMeta, { color: c.muted }]}>{project.description}</Text> : null}
    </View><Icon name="chevron-forward" size={16} color={c.muted} />
  </Pressable>;
});

export function ProjectScreen({ route }: NativeStackScreenProps<ProjectRoutes, "Project">) {
  const { client, cache } = useSession(); const c = useColours();
  const scope = useMemo(() => ({ cache, key: `project/${route.params.id}` }), [cache, route.params.id]);
  const { data, error, busy, updating, refresh } = useRemote(useCallback(async () => {
    const detail = await client.project(route.params.id);
    const id = detail.project.currentRevisionId;
    const [revision, bom] = id ? await Promise.all([client.revision(id), client.bom(id)]) : [undefined, []];
    return { ...detail, revision, bom };
  }, [client, route.params.id]), scope);
  const pull = usePullRefresh(refresh);
  return <ScrollView style={{ backgroundColor: c.background }} contentContainerStyle={styles.content} contentInsetAdjustmentBehavior="automatic"
    refreshControl={<RefreshControl {...pull} tintColor={c.accent} />}>
    <WorkspaceStatus /><Updating visible={updating} />
    {error && <><Notice error message={data ? `${error} Showing previously loaded details.` : error} /><Action quiet label="Refresh project" onPress={refresh} disabled={busy} /></>}
    {busy && !data && <Loading />}
    {data && <><View style={styles.hero}><SymbolTile name="folder-open-outline" large /><Copy title>{data.project.name}</Copy><StatusBadge label={humanise(data.project.status)} />
      {data.project.description && <Copy secondary>{data.project.description}</Copy>}</View>
      {data.revision && <Section title="Current plan"><Fact label="Revision" value={`${data.revision.name} · ${data.revision.number}`} /><Fact label="Build approach" value={humanise(data.revision.fabricationRoute)} />
        {data.revision.notes && <Copy>{data.revision.notes}</Copy>}</Section>}
      <Section title="Requirements">
        {data.bom.length === 0 ? <Copy secondary>No requirements in this plan yet.</Copy> : data.bom.map((line, index) => <View key={line.id} style={[styles.fact, { borderBottomColor: c.line }, index === data.bom.length - 1 && styles.factLast]}>
          <Copy>{line.name}</Copy><Copy secondary>{quantity(line.requiredQuantity, line.unit)} · {humanise(line.role ?? "role needs review")}{line.optional ? " · Optional" : ""}</Copy>
          {line.notes && <Copy secondary>{line.notes}</Copy>}
        </View>)}
        <Text style={[styles.small, { color: c.muted }]}>Requirements describe the plan. Review stock readiness and build checks in the web workspace.</Text>
      </Section>
      {data.workItems.length > 0 && <Section title="Work items">{data.workItems.map((item) => <Fact key={item.id} label={humanise(item.kind)} value={item.name} />)}</Section>}
    </>}
  </ScrollView>;
}

/** A retry of an unchanged form carries the original command identity. */
export function useCommandKey() {
  const attempt = useRef<{ fingerprint: string; key: string } | undefined>(undefined);
  return (input: unknown) => {
    const fingerprint = JSON.stringify(input);
    if (!attempt.current || attempt.current.fingerprint !== fingerprint) attempt.current = { fingerprint, key: Crypto.randomUUID() };
    return attempt.current.key;
  };
}
const preview = (value: string) => !value ? "(empty)" : value.length > 80 ? `${value.slice(0, 79)}…` : value;
function useFormGuard(dirty: boolean, busy: boolean, navigation: { dispatch(action: NavigationAction): void }) {
  usePreventRemove(dirty || busy, ({ data }) => {
    if (busy) { Alert.alert("Save in progress", "Wait for the server response before leaving."); return; }
    Alert.alert("Leave this form?", "Unsaved edits will be discarded. If a request timed out, it may have reached the server; check the record before starting again.", [
      { text: "Keep editing", style: "cancel" }, { text: "Leave", style: "destructive", onPress: () => navigation.dispatch(data.action) }
    ]);
  });
}

export function EditItemScreen({ route, navigation }: NativeStackScreenProps<InventoryRoutes, "EditItem">) {
  const { client, session } = useSession(); const c = useColours();
  const getKey = useCommandKey();
  const editor = useItemEditor(client, route.params.id, getKey);
  const { input, busy, error, conflict, saved, dirty, change } = editor;
  useFormGuard(dirty && !saved, busy, navigation);
  useEffect(() => { if (saved) navigation.goBack(); }, [saved, navigation]);
  // The scroll view adjusts its own insets for the keyboard below the native header.
  return <ScrollView style={[styles.screen, { backgroundColor: c.background }]} automaticallyAdjustKeyboardInsets keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive" contentContainerStyle={styles.content} contentInsetAdjustmentBehavior="automatic">
    <Copy secondary>Update the label and location. Stock quantities and evidence keep their own history.</Copy>
    {!input && !editor.loadError && <Loading />}
    {editor.loadError && <><Notice error message={editor.loadError} /><Action quiet label="Try again" onPress={() => { void editor.reload(); }} /></>}
    {input && <>
      <Field label="Item name" value={input.name} onChangeText={(name) => change({ name })} editable={!busy} maxLength={240} />
      <Field label="Location" value={input.location} onChangeText={(location) => change({ location })} editable={!busy} maxLength={240} placeholder="Drawer, shelf or storage box" />
      <Field label="Description" value={input.description} onChangeText={(description) => change({ description })} editable={!busy} maxLength={5000} multiline />
      {error && <Notice error message={error} />}
      {conflict ? <>
        <Copy secondary>Latest on the server: {conflict.name}{conflict.location ? ` · ${conflict.location}` : ""}. Fields you did not change take the latest values.</Copy>
        {editor.fieldConflicts.map(({ field, mine, theirs }) => <View key={field} style={{ gap: 8 }}>
          <Copy secondary>{`${humanise(field)} was changed on both sides. Choose which to keep.`}</Copy>
          <Action quiet={editor.choices[field] !== "mine"} label={`Mine: ${preview(mine)}`} onPress={() => editor.choose(field, "mine")} disabled={busy} />
          <Action quiet={editor.choices[field] !== "theirs"} label={`Server: ${preview(theirs)}`} onPress={() => editor.choose(field, "theirs")} disabled={busy} />
        </View>)}
        <Action icon="refresh" label="Keep my changes and retry" onPress={() => { void editor.keepMine(); }} busy={busy} disabled={editor.fieldConflicts.some(({ field }) => editor.choices[field] === undefined)} />
        <Action quiet destructive label="Discard my changes" onPress={editor.discard} disabled={busy} />
      </> : <Action icon="checkmark" label="Save details" onPress={() => { void editor.save(); }} busy={busy} disabled={!dirty || !input.name.trim() || !canWriteWorkspace(session)} />}
    </>}
    <Action quiet label="Cancel" onPress={() => navigation.goBack()} disabled={busy} />
  </ScrollView>;
}

export function NewProjectScreen({ navigation }: NativeStackScreenProps<ProjectRoutes, "NewProject">) {
  const { client, session } = useSession(); const c = useColours();
  const [name, setName] = useState(""); const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const [created, setCreated] = useState<Project>();
  const getKey = useCommandKey(); const inFlight = useRef(false);
  useFormGuard(!!(name || description) && !created, busy, navigation);
  useEffect(() => { if (created) navigation.replace("Project", { id: created.id }); }, [created, navigation]);
  async function save() {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError("");
    try { setCreated(await client.createProject(name, description, getKey({ name: name.trim(), description: description.trim() }))); }
    catch (e) { setError(e instanceof ClientError ? e.message : "Check the project details and try again."); }
    finally { setBusy(false); inFlight.current = false; }
  }
  return <ScrollView style={[styles.screen, { backgroundColor: c.background }]} automaticallyAdjustKeyboardInsets keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive" contentContainerStyle={styles.content} contentInsetAdjustmentBehavior="automatic">
      <SymbolTile name="folder-open-outline" large /><Copy title>What are you making?</Copy><Copy secondary>Start with a name and a short brief. This creates an idea and its first concept plan on your server.</Copy>
      <Field label="Project name" placeholder="e.g. Workshop lamp" value={name} onChangeText={setName} maxLength={240} editable={!busy} />
      <Field label="Brief" placeholder="What should it do?" value={description} onChangeText={setDescription} maxLength={5000} multiline editable={!busy} />
      {error && <Notice error message={error} />}
      <Action icon="add" label="Create project" onPress={save} busy={busy} disabled={!name.trim() || !canWriteWorkspace(session)} />
      <Action quiet label="Cancel" onPress={() => navigation.goBack()} disabled={busy} />
  </ScrollView>;
}

export function ServerScreen({ navigation }: { navigation: { navigate(route: "PendingChanges"): void } }) {
  const { client, session, version, demo, disconnect, provisional, cache } = useSession(); const c = useColours();
  const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  const queue = useStockQueue(); const entries = useQueueEntries(queue);
  const unsent = entries.filter((e) => e.status !== "sent").length;
  const synced = useLastSynced(cache);
  const preferencesScope = useMemo(() => ({ cache, key: "workspace/preferences" }), [cache]);
  const { data: preferences } = useRemote(useCallback(() => client.workspacePreferences(), [client]), preferencesScope);
  const policy = preferences ? stockReceivingPolicyText(preferences.stockReceivingPolicy) : undefined;
  async function signOut() {
    setBusy(true); setError("");
    try { await disconnect(); } catch { setError("Could not remove the saved credential. Try disconnecting again."); setBusy(false); }
  }
  function leave() {
    if (!unsent) { void signOut(); return; }
    // Never drop recorded stock changes without an explicit choice.
    Alert.alert("Discard unsent stock changes?", `${unsent} stock ${unsent === 1 ? "change has" : "changes have"} not reached your server. Disconnecting removes ${unsent === 1 ? "it" : "them"} from this phone.`, [
      { text: "Keep connected", style: "cancel" }, { text: "Disconnect and discard", style: "destructive", onPress: () => { void signOut(); } }
    ]);
  }
  return <ScrollView style={{ backgroundColor: c.background }} contentContainerStyle={styles.content} contentInsetAdjustmentBehavior="automatic">
    {demo && <><View style={styles.hero}><SymbolTile name="eye-outline" large /><Copy title>Sample workspace</Copy><Copy secondary>Explore synthetic inventory and projects. No server connection or credentials are used.</Copy></View>
      <Notice message="This sample is read only. Connect your own BenchLedger server to edit items and create projects." />
      <Action quiet icon="log-out-outline" label="Leave sample workspace" onPress={() => { void signOut(); }} busy={busy} />
    </>}
    {!demo && <>
    <View style={styles.hero}><SymbolTile name="server-outline" large /><Copy title>Your workspace</Copy><Copy secondary>Connected directly to your BenchLedger server.</Copy></View>
    <WorkspaceStatus />
    <Group><Fact label="Server" value={client.connection.server} /><Fact label="Version" value={version || "Not confirmed yet"} />
      <Fact label="Access" value={provisional ? "Not confirmed yet · read only" : session.projectIds !== undefined ? "Selected projects" : canWriteWorkspace(session) ? "Read and write" : "Read only"} /></Group>
    {policy && <Section title="Stock setting"><Fact label="Stock counts as in stock" value={policy.label.replace(/^When/u, "when")} />
      <Copy secondary>{`${policy.explanation} Change this in the web app's settings.`}</Copy></Section>}
    {client.connection.server.startsWith("http:") && <Notice message="Local HTTP is unencrypted. Use it only on a network you trust, or configure HTTPS on your server." />}
    <Section title="On this device"><Copy secondary>The connection is kept in secure device storage. {cache.persistent ? "The last inventory and project responses are saved on this phone for offline use." : "Inventory and project responses stay in memory for this session."} Disconnect removes the saved connection, saved responses, photos and unsent changes from this device.</Copy>
      <Fact label="Last synced" value={syncedLabel(synced).replace(/^Last synced /u, "")} />
      <Pressable accessibilityRole="button" onPress={() => navigation.navigate("PendingChanges")}><Fact last label="Stock changes waiting" value={unsent ? `${unsent} · Review` : "None · Review"} /></Pressable></Section>
    <Section title="Full workspace"><Copy secondary>Use the web app for purchases, file uploads, readiness checks and build reconciliation.</Copy></Section>
    {error && <Notice error message={error} />}
    <Action quiet icon="open-outline" label="Open web workspace" onPress={() => { void Linking.openURL(client.connection.server).catch(() => setError("Could not open the web workspace.")); }} />
    <Action quiet destructive icon="log-out-outline" label="Disconnect" onPress={leave} busy={busy} />
    </>}
  </ScrollView>;
}
