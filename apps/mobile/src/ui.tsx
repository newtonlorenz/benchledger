import { Children, cloneElement, createContext, isValidElement, useContext, type ComponentProps, type PropsWithChildren, type ReactElement, type ReactNode } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View, useColorScheme, useWindowDimensions, type TextInputProps } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import type { InventoryItem } from "@benchledger/api-contract";
import { evidenceLabel, formatQuantity } from "./presentation";

// Content stays opaque. UIKit owns the glass material in navigation and toolbars.
const light = { background: "#f5f4f1", surface: "#ffffff", text: "#22221f", muted: "#686862", line: "#e7e6e1", accent: "#b84213", accentSoft: "#fae9df", onAccent: "#ffffff", status: "#3c5470", statusBg: "#e7edf4", warning: "#805208", warningBg: "#fff3d9", success: "#216448", successBg: "#e8f2eb", error: "#b12b32", errorBg: "#fcecef" };
const dark: typeof light = { background: "#111210", surface: "#20221f", text: "#f4f4ed", muted: "#adada5", line: "#353832", accent: "#ffa16e", accentSoft: "#3c2a20", onAccent: "#2b190d", status: "#b9cbe2", statusBg: "#26303c", warning: "#edc684", warningBg: "#362d1d", success: "#91d6ae", successBg: "#233a2c", error: "#ffacb1", errorBg: "#3d2327" };
const ColourContext = createContext(light);
export function Colours({ children }: PropsWithChildren) {
  return <ColourContext.Provider value={useColorScheme() === "dark" ? dark : light}>{children}</ColourContext.Provider>;
}
export const useColours = () => useContext(ColourContext);
export type IconName = ComponentProps<typeof Ionicons>["name"];
export function AdaptiveScrollView(props: ComponentProps<typeof ScrollView>) {
  const { fontScale } = useWindowDimensions();
  // Recreate measured content when Dynamic Type changes. Native text can
  // repaint at the new size while a cached scroll layout keeps old heights.
  // Form values and fetched records live in the screen, outside this subtree.
  return <ScrollView key={fontScale} {...props} />;
}
export function Icon({ name, size = 22, color }: { name: IconName; size?: number; color?: string }) {
  const c = useColours();
  return <Ionicons accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" name={name} size={size} color={color ?? c.accent} />;
}
export function SymbolTile({ name, large = false }: { name: IconName; large?: boolean }) {
  const c = useColours();
  return <View style={[styles.symbol, large && styles.symbolLarge, { backgroundColor: c.accentSoft }]}><Icon name={name} size={large ? 34 : 25} color={c.accent} /></View>;
}
export function BrandMark() {
  const c = useColours();
  return <View accessible accessibilityLabel="BenchLedger" style={[styles.brand, { backgroundColor: c.accent }]}>
    {[0.45, 0.72, 1].map((height) => <View key={height} style={{ flex: 1, height: `${height * 100}%`, backgroundColor: c.onAccent, borderRadius: 2 }} />)}
  </View>;
}
export function Copy({ children, secondary = false, title = false }: PropsWithChildren<{ secondary?: boolean; title?: boolean }>) {
  const c = useColours();
  return <Text style={[title ? styles.title : styles.copy, { color: secondary ? c.muted : c.text }]}>{children}</Text>;
}
/** An inset surface whose final fact row drops its separator hairline. */
export function Group({ children }: { children: ReactNode }) {
  const c = useColours();
  const items = Children.toArray(children).filter(isValidElement);
  const last = items.length - 1;
  return <View style={[styles.group, { backgroundColor: c.surface }]}>
    {items.map((child, index) => index === last && child.type === Fact ? cloneElement(child as ReactElement<FactProps>, { last: true }) : child)}
  </View>;
}
export function Section({ title, children }: PropsWithChildren<{ title: string }>) {
  const c = useColours();
  return <View style={styles.section}><Text accessibilityRole="header" style={[styles.heading, { color: c.text }]}>{title}</Text>
    <Group>{children}</Group>
  </View>;
}
export function Action({ label, onPress, disabled = false, quiet = false, busy = false, icon, destructive = false }: {
  label: string; onPress(): void; disabled?: boolean; quiet?: boolean; busy?: boolean; icon?: IconName; destructive?: boolean
}) {
  const c = useColours(); const color = destructive ? c.error : quiet ? c.accent : c.onAccent;
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled: disabled || busy, busy }}
    disabled={disabled || busy} onPress={onPress}
    style={({ pressed }) => [styles.button, { backgroundColor: quiet ? c.surface : c.accent, opacity: disabled || busy ? 0.5 : pressed ? 0.72 : 1 }]}>
    {busy && <ActivityIndicator color={color} />}
    <Text style={[styles.buttonText, { color }]}>{label}</Text>
    {!busy && icon && <Icon name={icon} color={color} size={20} />}
  </Pressable>;
}
export function Field({ label, ...props }: TextInputProps & { label: string }) {
  const c = useColours();
  // The input carries the spoken label; hide the visual label so it is not read twice.
  return <View style={styles.field}><Text accessible={false} accessibilityElementsHidden importantForAccessibility="no" style={[styles.label, { color: c.muted }]}>{label}</Text>
    <TextInput accessibilityLabel={label} placeholderTextColor={c.muted} selectionColor={c.accent}
      {...props} style={[styles.input, { color: c.text, backgroundColor: c.surface }, props.multiline && styles.multiline, props.style]} />
  </View>;
}
export function Notice({ message, error = false }: { message: string; error?: boolean }) {
  const c = useColours();
  return <Text accessibilityRole={error ? "alert" : "text"} accessibilityLiveRegion="polite"
    style={[styles.notice, { color: error ? c.error : c.warning, backgroundColor: error ? c.errorBg : c.warningBg }]}>{message}</Text>;
}
export function Loading() { return <View style={styles.empty}><ActivityIndicator accessibilityLabel="Loading" size="large" color={useColours().accent} /></View>; }
export function Empty({ title, message }: { title: string; message: string }) {
  return <View style={styles.empty}><SymbolTile name="file-tray-outline" large /><Copy title>{title}</Copy><Copy secondary>{message}</Copy></View>;
}
type FactProps = { label: string; value: string; last?: boolean };
export function Fact({ label, value, last = false }: FactProps) {
  const c = useColours(); const { fontScale } = useWindowDimensions(); const stacked = fontScale > 1.3 || value.length > 44;
  return <View style={[styles.fact, !stacked && styles.factInline, { borderBottomColor: c.line }, last && styles.factLast]}>
    <Text style={[styles.factLabel, { color: c.muted }]}>{label}</Text>
    <Text selectable style={[styles.copy, { color: c.text }, !stacked && styles.factValue]}>{value}</Text>
  </View>;
}
export function Evidence({ item }: { item: InventoryItem }) {
  const c = useColours();
  const confirmed = (item.evidence.state === "physically_counted" || item.evidence.state === "commissioned") && item.unitStatus !== "needs_correction";
  return <Text style={[styles.badge, { color: confirmed ? c.success : c.warning, backgroundColor: confirmed ? c.successBg : c.warningBg }]}>
    {evidenceLabel(item)}
  </Text>;
}
export function itemIcon(kind: InventoryItem["kind"]): IconName {
  if (kind === "printer") return "print-outline";
  if (kind === "filament") return "disc-outline";
  if (kind === "electronic") return "hardware-chip-outline";
  if (kind === "tool") return "hammer-outline";
  return "cube-outline";
}
export function humanise(value: string) { return value.replaceAll("_", " ").replace(/^./u, (v) => v.toUpperCase()); }
export const quantity = (value: number, unit: InventoryItem["unit"]) => formatQuantity(value, unit);
/** Lifecycle state, kept visually distinct from the orange primary action colour. */
export function StatusBadge({ label }: { label: string }) {
  const c = useColours();
  return <Text style={[styles.badge, { color: c.status, backgroundColor: c.statusBg }]}>{label}</Text>;
}

export const styles = StyleSheet.create({
  screen: { flex: 1 }, content: { paddingHorizontal: 20, paddingTop: 20, gap: 20, paddingBottom: 44 },
  title: { fontSize: 30, lineHeight: 36, fontWeight: "700", letterSpacing: -0.8 },
  heading: { fontSize: 21, fontWeight: "700", letterSpacing: -0.3, marginLeft: 4 },
  copy: { fontSize: 17, lineHeight: 24 }, label: { fontSize: 14, fontWeight: "500", lineHeight: 20, marginLeft: 4 },
  button: { minHeight: 54, paddingHorizontal: 22, paddingVertical: 15, borderRadius: 28, alignItems: "center", justifyContent: "center", flexDirection: "row", gap: 10 },
  buttonText: { fontSize: 17, fontWeight: "600" }, field: { gap: 7 },
  input: { borderRadius: 16, borderCurve: "continuous", minHeight: 54, paddingHorizontal: 16, paddingVertical: 15, fontSize: 17 },
  multiline: { minHeight: 128, textAlignVertical: "top" },
  notice: { padding: 16, borderRadius: 16, fontSize: 15, lineHeight: 22 },
  section: { marginTop: 8, gap: 12 }, group: { borderRadius: 22, borderCurve: "continuous", padding: 18, gap: 12 },
  fact: { paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, gap: 8 }, factLast: { borderBottomWidth: 0, paddingBottom: 0 },
  factInline: { flexDirection: "row", alignItems: "baseline", gap: 20 },
  factLabel: { fontSize: 15, lineHeight: 22, flexShrink: 1 }, factValue: { flex: 1, textAlign: "right" },
  empty: { padding: 28, minHeight: 260, justifyContent: "center", alignItems: "flex-start", gap: 16 },
  row: { marginHorizontal: 20, padding: 16, flexDirection: "row", alignItems: "center", gap: 14 },
  rowBody: { flex: 1, gap: 6 }, rowTitle: { fontSize: 17, lineHeight: 23, fontWeight: "600", letterSpacing: -0.2 },
  rowMeta: { fontSize: 14, lineHeight: 20 },
  firstRow: { borderTopLeftRadius: 22, borderTopRightRadius: 22 }, lastRow: { borderBottomLeftRadius: 22, borderBottomRightRadius: 22 },
  separator: { height: StyleSheet.hairlineWidth, marginLeft: 96, marginRight: 20 },
  badge: { alignSelf: "flex-start", fontSize: 12, lineHeight: 17, fontWeight: "500", paddingVertical: 3, paddingHorizontal: 8, borderRadius: 6, overflow: "hidden" },
  search: { paddingHorizontal: 20, paddingTop: 8, paddingBottom: 22, gap: 16 }, footer: { paddingHorizontal: 24, paddingTop: 18, paddingBottom: 32, gap: 12 },
  switchRow: { flexDirection: "row", alignItems: "center", gap: 16 }, flex: { flex: 1 },
  brand: { width: 72, height: 72, borderRadius: 21, borderCurve: "continuous", padding: 18, flexDirection: "row", gap: 6, alignItems: "flex-end" },
  symbol: { width: 48, height: 48, borderRadius: 14, borderCurve: "continuous", alignItems: "center", justifyContent: "center" },
  symbolLarge: { width: 72, height: 72, borderRadius: 22 },
  hero: { gap: 14, paddingTop: 8, paddingBottom: 8 },
  connection: { paddingHorizontal: 24, paddingTop: 30, paddingBottom: 36, gap: 24, maxWidth: 560, width: "100%", alignSelf: "center" },
  connectionTitle: { fontSize: 36, lineHeight: 41, letterSpacing: -1, fontWeight: "700" },
  connectionFields: { borderRadius: 22, borderCurve: "continuous", padding: 18, gap: 14 },
  secureNote: { flexDirection: "row", alignItems: "flex-start", gap: 8, paddingHorizontal: 8 },
  small: { fontSize: 14, lineHeight: 20 },
  stockRow: { flexDirection: "row", gap: 24 }, stockColumn: { flex: 1, gap: 6 },
  stockNumber: { fontSize: 28, lineHeight: 34, fontWeight: "600", fontVariant: ["tabular-nums"], letterSpacing: -0.5 }
});
