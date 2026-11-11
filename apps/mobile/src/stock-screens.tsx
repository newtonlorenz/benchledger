import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import * as Haptics from "expo-haptics";
import type { InventoryItem } from "@benchledger/api-contract";
import type { InventoryRoutes } from "./navigation";
import { formatNumber, stockActions } from "./presentation";
import { useSession } from "./session";
import { adjustmentPreview, parseQuantity, stepQuantity, stepsFor, validateAdjustment, type StockKind } from "./stock-adjust";
import { useQueueEntries, useStockQueue } from "./stock-context";
import type { QueueEntry } from "./stock-queue";
import { useRemote } from "./use-remote";
import { Action, AdaptiveScrollView as ScrollView, Copy, Group, Loading, Notice, Section, humanise, quantity, styles, useColours } from "./ui";

const tap = () => { void Haptics.selectionAsync().catch(() => undefined); };
const signed = (value: number) => `${value > 0 ? "+" : value < 0 ? "−" : "±"}${formatNumber(Math.abs(value))}`;

/**
 * Quick count / receipt at the bench: large steppers, explicit before → after
 * confirmation, and a device-side queue so poor Wi-Fi never loses a count.
 */
export function QuickStockScreen({ route, navigation }: NativeStackScreenProps<InventoryRoutes, "AdjustStock">) {
  const { client, cache, reachability, provisional } = useSession(); const c = useColours();
  const queue = useStockQueue();
  const entries = useQueueEntries(queue);
  const scope = useMemo(() => ({ cache, key: `item/${route.params.id}` }), [cache, route.params.id]);
  const { data: item, error, busy } = useRemote(useCallback(() => client.item(route.params.id), [client, route.params.id]), scope);
  const actions = item ? stockActions(item) : undefined;
  const [chosen, setKind] = useState<StockKind>(route.params.kind ?? "count");
  // Delivered or ordered stock is received by counting it; current servers refuse a receipt event first.
  const kind: StockKind = actions && !actions.allowReceipt ? "count" : chosen;
  const receiving = actions?.primary === "Receive and count";
  const [text, setText] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<QueueEntry>();
  const unsent = entries.filter((e) => e.itemId === route.params.id && e.status !== "sent");
  const lastUnsent = unsent.at(-1);
  // The before figure follows any change still waiting to send.
  const before = lastUnsent ? lastUnsent.after : item?.quantity ?? 0;
  useEffect(() => { if (item && text === "") setText(kind === "count" ? formatInput(before) : "1"); }, [item, kind]);
  const value = parseQuantity(text);
  const problem = item ? validateAdjustment(kind, value, item.unit) : undefined;
  const preview = adjustmentPreview(kind, before, Number.isFinite(value) ? value : 0);
  const savedEntry = saved ? entries.find((e) => e.id === saved.id) ?? saved : undefined;

  const switchKind = (next: StockKind) => { tap(); setKind(next); setConfirming(false); setText(next === "count" ? formatInput(before) : "1"); };
  const step = (amount: number) => { tap(); setConfirming(false); setText(formatInput(stepQuantity(Number.isFinite(value) ? value : 0, amount))); };
  async function record(target: InventoryItem) {
    if (!queue || saving) return;
    setSaving(true);
    try {
      const entry = await queue.enqueue({ itemId: target.id, itemName: target.name, unit: target.unit, kind, quantity: value, item: target });
      setSaved(entry); setConfirming(false);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
    } catch {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => undefined);
      setSaved(undefined);
    } finally { setSaving(false); }
  }

  if (!item) return <ScrollView style={{ backgroundColor: c.background }} contentContainerStyle={styles.content} contentInsetAdjustmentBehavior="automatic">
    {busy ? <Loading /> : <Notice error message={error || "This item is not available on this device yet. Open it once while online."} />}
  </ScrollView>;
  const unit = quantity(0, item.unit).replace(/^0\s*/u, "");
  return <ScrollView style={{ backgroundColor: c.background }} contentContainerStyle={styles.content} contentInsetAdjustmentBehavior="automatic" keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
    <View style={styles.hero}><Copy title>{item.name}</Copy><Copy secondary>{item.location ? `${item.location} · ` : ""}Recorded {quantity(item.quantity, item.unit)}</Copy></View>
    <View accessibilityRole="tablist" style={[stock.segments, { backgroundColor: c.surface }]}>
      {(actions?.allowReceipt === false ? ["count"] as const : ["count", "receipt"] as const).map((option) => <Pressable key={option} accessibilityRole="tab" accessibilityState={{ selected: kind === option }} onPress={() => switchKind(option)}
        style={[stock.segment, kind === option && { backgroundColor: c.accent }]}>
        <Text style={[styles.buttonText, { color: kind === option ? c.onAccent : c.text }]}>{option === "count" ? receiving ? "Receive and count" : "Count" : "Received"}</Text>
      </Pressable>)}
    </View>
    <Copy secondary>{kind === "count" ? receiving ? "Count what has arrived. This records it as received and replaces the recorded quantity." : "Enter how many you can physically see now. This replaces the recorded quantity." : "Add stock that has just arrived. This adds to the recorded quantity."}</Copy>
    <View style={[stock.counter, { backgroundColor: c.surface }]}>
      <TextInput accessibilityLabel={kind === "count" ? `Counted quantity in ${unit}` : `Received quantity in ${unit}`} value={text} keyboardType="decimal-pad" selectTextOnFocus
        onChangeText={(next) => { setConfirming(false); setText(next.slice(0, 14)); }} style={[stock.value, { color: c.text }]} />
      <Text style={[styles.copy, { color: c.muted, textAlign: "center" }]}>{unit}</Text>
      <View style={stock.steppers}>
        {[...stepsFor(item.unit)].reverse().map((amount) => <Stepper key={`-${amount}`} label={`−${formatNumber(amount)}`} spoken={`Decrease by ${formatNumber(amount)}`} onPress={() => step(-amount)} />)}
      </View>
      <View style={stock.steppers}>
        {stepsFor(item.unit).map((amount) => <Stepper key={`+${amount}`} label={`+${formatNumber(amount)}`} spoken={`Increase by ${formatNumber(amount)}`} onPress={() => step(amount)} />)}
      </View>
    </View>
    {problem && text !== "" ? <Notice error message={problem} /> : null}
    {!confirming ? <Action icon="checkmark" label="Review change" disabled={!!problem || !queue} onPress={() => { tap(); setConfirming(true); setSaved(undefined); }} />
      : <Group>
        <Text accessibilityRole="header" style={[styles.heading, { color: c.text, marginLeft: 0 }]}>{kind === "count" ? "Record this count?" : "Record this receipt?"}</Text>
        <View style={stock.compare} accessible accessibilityLabel={`${quantity(preview.before, item.unit)} becomes ${quantity(preview.after, item.unit)}, a change of ${signed(preview.delta)}`}>
          <View style={styles.flex}><Text style={[styles.small, { color: c.muted }]}>Before</Text><Text style={[styles.stockNumber, { color: c.text }]}>{quantity(preview.before, item.unit)}</Text></View>
          <Text style={[styles.title, { color: c.muted }]}>→</Text>
          <View style={styles.flex}><Text style={[styles.small, { color: c.muted }]}>After</Text><Text style={[styles.stockNumber, { color: c.text }]}>{quantity(preview.after, item.unit)}</Text></View>
        </View>
        <Text style={[styles.small, { color: c.muted }]}>Change {signed(preview.delta)}. {reachability === "online" && !provisional ? "Sends to your server now." : "Saved on this phone and sent when your workspace is reachable."}</Text>
        <Action icon="checkmark-done" label={kind === "count" ? "Record count" : "Record receipt"} busy={saving} onPress={() => { void record(item); }} />
        <Action quiet label="Change quantity" onPress={() => setConfirming(false)} disabled={saving} />
      </Group>}
    {savedEntry && <Notice message={entryStatusText(savedEntry, item.unit)} />}
    {unsent.length > 0 && <Section title="Waiting to send">{unsent.map((entry, index) => <QueueEntryRow key={entry.id} entry={entry} last={index === unsent.length - 1} />)}</Section>}
    <Action quiet label="Done" onPress={() => navigation.goBack()} disabled={saving} />
  </ScrollView>;
}

function Stepper({ label, spoken, onPress }: { label: string; spoken: string; onPress(): void }) {
  const c = useColours();
  return <Pressable accessibilityRole="button" accessibilityLabel={spoken} onPress={onPress} hitSlop={4}
    style={({ pressed }) => [stock.stepper, { backgroundColor: pressed ? c.accent : c.accentSoft }]}>
    {({ pressed }) => <Text style={[stock.stepperText, { color: pressed ? c.onAccent : c.accent }]}>{label}</Text>}
  </Pressable>;
}

function formatInput(value: number) { return String(Math.round(value * 1000) / 1000); }

export function entryStatusText(entry: QueueEntry, unit: string) {
  const change = `${entry.kind === "count" ? "Count" : "Receipt"} ${quantity(entry.before, unit as InventoryItem["unit"])} → ${quantity(entry.after, unit as InventoryItem["unit"])}`;
  switch (entry.status) {
    case "sent": return `${change}: sent to your server.`;
    case "sending": return `${change}: sending…`;
    case "conflict": return `${change}: needs your decision. ${entry.message ?? ""}${entry.serverQuantity !== undefined ? ` The server now shows ${quantity(entry.serverQuantity, unit as InventoryItem["unit"])}.` : ""}`.trim();
    case "failed": return `${change}: not accepted. ${entry.message ?? ""}`.trim();
    default: return `${change}: saved on this phone, waiting to send.${entry.message ? ` ${entry.message}` : ""}`;
  }
}

/** One queued change with its status and the actions that resolve it. */
export function QueueEntryRow({ entry, last = false }: { entry: QueueEntry; last?: boolean }) {
  const c = useColours(); const queue = useStockQueue();
  const tone = entry.status === "conflict" || entry.status === "failed" ? c.error : entry.status === "sent" ? c.success : c.muted;
  return <View style={[styles.fact, { borderBottomColor: c.line, gap: 10 }, last && styles.factLast]}>
    <Copy>{entry.itemName}</Copy>
    <Text style={[styles.small, { color: tone }]}>{entryStatusText(entry, entry.unit)}</Text>
    <Text style={[styles.small, { color: c.muted }]}>{humanise(entry.status)} · recorded {new Date(entry.createdAt).toLocaleString()}</Text>
    {entry.status === "conflict" && entry.serverQuantity !== undefined && <Action quiet icon="checkmark" label={`Apply on top of ${formatNumber(entry.serverQuantity)}`} onPress={() => { void queue?.accept(entry.id); }} />}
    {entry.status === "failed" && <Action quiet icon="refresh" label="Try again" onPress={() => { void queue?.retry(entry.id); }} />}
    {entry.status !== "sending" && entry.status !== "sent" && <Action quiet destructive label="Discard this change" onPress={() => { void queue?.discard(entry.id); }} />}
  </View>;
}

/** Every change recorded on this phone, for review after working offline. */
export function PendingChangesScreen() {
  const { reachability, provisional, retry, client, cache } = useSession(); const c = useColours();
  const queue = useStockQueue(); const entries = useQueueEntries(queue);
  const sent = entries.filter((e) => e.status === "sent");
  const waiting = entries.some((e) => e.status === "pending");
  const [sending, setSending] = useState(false);
  async function sendNow() {
    if (!queue) return;
    setSending(true);
    try { const { sent: done } = await queue.replay(client); if (done.length) cache.revalidate(); }
    finally { setSending(false); }
  }
  return <ScrollView style={{ backgroundColor: c.background }} contentContainerStyle={styles.content} contentInsetAdjustmentBehavior="automatic">
    <Copy secondary>Stock counts and receipts recorded on this phone. They send in the order you made them; each keeps one request ID, so a retry is never applied twice.</Copy>
    {(reachability !== "online" || provisional) && <><Notice message="Your workspace isn't reachable yet. Changes stay on this phone until it is." /><Action quiet icon="refresh" label="Retry now" onPress={() => { void retry(); }} /></>}
    {reachability === "online" && !provisional && waiting && <Action icon="cloud-upload-outline" label="Send now" busy={sending} onPress={() => { void sendNow(); }} />}
    {entries.length === 0 ? <Copy secondary>Nothing waiting. Recorded changes appear here until they are sent.</Copy>
      : <Group>{entries.map((entry, index) => <QueueEntryRow key={entry.id} entry={entry} last={index === entries.length - 1} />)}</Group>}
    {sent.length > 0 && <Action quiet label="Clear sent changes" onPress={() => { void queue?.clearSent(); }} />}
  </ScrollView>;
}

const stock = StyleSheet.create({
  segments: { flexDirection: "row", borderRadius: 28, padding: 4, gap: 4 },
  segment: { flex: 1, minHeight: 46, borderRadius: 24, alignItems: "center", justifyContent: "center" },
  counter: { borderRadius: 22, borderCurve: "continuous", padding: 18, gap: 8 },
  value: { fontSize: 56, lineHeight: 64, fontWeight: "700", textAlign: "center", fontVariant: ["tabular-nums"], paddingVertical: 4 },
  steppers: { flexDirection: "row", gap: 10, paddingTop: 8 },
  stepper: { flex: 1, minWidth: 64, minHeight: 64, paddingHorizontal: 14, borderRadius: 20, borderCurve: "continuous", alignItems: "center", justifyContent: "center" },
  stepperText: { fontSize: 22, fontWeight: "700", fontVariant: ["tabular-nums"] },
  compare: { flexDirection: "row", alignItems: "center", gap: 12 }
});
