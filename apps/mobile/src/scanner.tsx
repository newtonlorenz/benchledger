import { useEffect, useRef } from "react";
import { Linking, Modal, StyleSheet, Text, View } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { CameraView, useCameraPermissions, type BarcodeType } from "expo-camera";
import * as Haptics from "expo-haptics";
import { Action, Copy, Loading, styles, useColours } from "./ui";

const barcodeTypes: BarcodeType[] = ["qr", "datamatrix", "ean13", "ean8", "upc_a", "upc_e", "code128", "code39"];

/**
 * Full-screen camera scanner. It reports the first code once and closes; the
 * caller decides what the code means (see scan.ts). Scanned data is never logged.
 */
export function ScannerModal({ visible, title, hint, onClose, onScan }: {
  visible: boolean; title: string; hint: string; onClose(): void; onScan(data: string): void;
}) {
  const c = useColours();
  const [permission, requestPermission] = useCameraPermissions();
  const handled = useRef(false);
  useEffect(() => { if (visible) handled.current = false; }, [visible]);
  useEffect(() => { if (visible && permission && !permission.granted && permission.canAskAgain && permission.status === "undetermined") void requestPermission(); }, [visible, permission, requestPermission]);
  const scanned = ({ data }: { data: string }) => {
    if (handled.current) return;
    handled.current = true;
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
    onClose(); onScan(data);
  };
  // A native modal is a separate window: it needs its own safe-area provider.
  return <Modal visible={visible} animationType="slide" presentationStyle="fullScreen" onRequestClose={onClose}><SafeAreaProvider>
    <SafeAreaView style={[styles.screen, { backgroundColor: permission?.granted ? "#000" : c.background }]}>
      {!permission ? <Loading /> : !permission.granted ? <View style={styles.connection}>
        <Copy title>Camera access needed</Copy>
        <Copy secondary>BenchLedger uses the camera only while this scanner is open, to read item labels and pairing codes. Nothing is recorded or uploaded.</Copy>
        {permission.canAskAgain
          ? <Action icon="camera-outline" label="Allow camera" onPress={() => { void requestPermission(); }} />
          : <Action icon="settings-outline" label="Open Settings" onPress={() => { void Linking.openSettings(); }} />}
        <Action quiet label="Close" onPress={onClose} />
      </View> : <>
        <CameraView style={StyleSheet.absoluteFill} facing="back" barcodeScannerSettings={{ barcodeTypes }} onBarcodeScanned={scanned} />
        <View style={scanner.overlay} pointerEvents="box-none">
          <View style={scanner.label}><Text accessibilityRole="header" style={[styles.heading, scanner.text]}>{title}</Text>
            <Text style={[styles.copy, scanner.text]}>{hint}</Text></View>
          <View style={scanner.frame} accessible={false} />
          <Action label="Cancel" onPress={onClose} />
        </View>
      </>}
    </SafeAreaView>
  </SafeAreaProvider></Modal>;
}

const scanner = StyleSheet.create({
  overlay: { flex: 1, justifyContent: "space-between", padding: 24, gap: 24 },
  label: { gap: 8, padding: 16, borderRadius: 22, backgroundColor: "rgba(0,0,0,0.55)" },
  text: { color: "#fff", marginLeft: 0 },
  frame: { alignSelf: "center", width: 240, height: 240, borderRadius: 28, borderWidth: 3, borderColor: "rgba(255,255,255,0.9)" }
});
