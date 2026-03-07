/**
 * EchoGuide — Main Camera Screen (React Native / Expo)
 *
 * Features:
 *  • Live camera feed
 *  • Scan Scene, Read Text, Identify People, Remember Person
 *  • Guide Mode (auto-scan every 2 s)
 *  • Face bounding box overlay
 *  • ElevenLabs TTS audio + expo-speech fallback
 */

import React, { useRef, useState, useEffect, useCallback } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  Alert,
  ActivityIndicator,
  Dimensions,
  Platform,
} from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import { Audio } from "expo-av";
import * as Speech from "expo-speech";
import Svg, { Rect, Text as SvgText } from "react-native-svg";

import {
  scanScene,
  readText,
  identifyAllPersons,
  rememberPerson,
  guideScan,
  speakText,
  getMe,
  logout,
} from "../api";

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get("window");
const CAMERA_RATIO = 4 / 3;
const CAM_H = SCREEN_W * CAMERA_RATIO;

export default function MainScreen({ navigation }) {
  const [permission, requestPermission] = useCameraPermissions();
  const cameraRef = useRef(null);

  const [username, setUsername] = useState("");
  const [busy, setBusy] = useState(false);
  const [statusText, setStatusText] = useState("Ready.");
  const [statusType, setStatusType] = useState("idle"); // idle | working | ok | error
  const [answerText, setAnswerText] = useState("Tap an action to start.");
  const [faces, setFaces] = useState([]);
  const [camSize, setCamSize] = useState({ width: SCREEN_W, height: CAM_H });

  const [guideActive, setGuideActive] = useState(false);
  const guideTimer = useRef(null);
  const guideRef = useRef(guideActive); // keep ref in sync for use inside interval

  useEffect(() => { guideRef.current = guideActive; }, [guideActive]);

  // Load username
  useEffect(() => {
    getMe().then(u => { if (u) setUsername(u.username); });
  }, []);

  // ── camera layout ─────────────────────────────────────────────────────────

  const onCamLayout = useCallback((e) => {
    const { width, height } = e.nativeEvent.layout;
    setCamSize({ width, height });
  }, []);

  // ── audio ─────────────────────────────────────────────────────────────────

  async function playBase64Audio(b64) {
    try {
      const uri = `data:audio/mpeg;base64,${b64}`;
      const { sound } = await Audio.Sound.createAsync({ uri });
      await sound.playAsync();
      sound.setOnPlaybackStatusUpdate((s) => {
        if (s.didJustFinish) sound.unloadAsync();
      });
    } catch (e) {
      console.warn("[Audio] playback error:", e);
    }
  }

  async function speak(text) {
    // Try TTS via backend for natural voice; fall back to device TTS
    try {
      const blob = await speakText(text);
      if (blob) {
        const reader = new FileReader();
        reader.onloadend = () => {
          const b64 = reader.result.split(",")[1];
          playBase64Audio(b64);
        };
        reader.readAsDataURL(blob);
        return;
      }
    } catch (_) {}
    Speech.speak(text, { rate: 1.05 });
  }

  // ── frame capture ─────────────────────────────────────────────────────────

  async function captureFrame() {
    if (!cameraRef.current) throw new Error("Camera not ready.");
    const photo = await cameraRef.current.takePictureAsync({
      quality: 0.7,
      base64: false,
      skipProcessing: true,
    });
    return photo.uri;
  }

  // ── actions ───────────────────────────────────────────────────────────────

  async function runAction(label, fn) {
    if (busy) return;
    setBusy(true);
    setStatusText(`${label}…`);
    setStatusType("working");
    setFaces([]);
    try {
      const uri = await captureFrame();
      const data = await fn(uri);
      const text = data.text || "No result.";
      setAnswerText(text);
      setStatusText("Done.");
      setStatusType("ok");
      if (data.audio_base64) {
        await playBase64Audio(data.audio_base64);
      } else {
        speak(text);
      }
      // Draw face boxes if present
      if (data.faces?.length) {
        setFaces(data.faces);
        setTimeout(() => setFaces([]), 6000);
      }
    } catch (err) {
      const msg = err.message || "Error.";
      setAnswerText(`Error: ${msg}`);
      setStatusText(msg);
      setStatusType("error");
      Speech.speak(msg);
    } finally {
      setBusy(false);
    }
  }

  async function handleScanScene() {
    await runAction("Scanning", scanScene);
  }

  async function handleReadText() {
    await runAction("Reading text", readText);
  }

  async function handleIdentify() {
    await runAction("Identifying people", identifyAllPersons);
  }

  async function handleRemember() {
    Alert.prompt(
      "Remember Person",
      "Enter the person's name:",
      async (name) => {
        if (!name?.trim()) return;
        await runAction(`Saving ${name}`, (uri) => rememberPerson(uri, name.trim()));
      },
      "plain-text"
    );
  }

  // ── guide mode ────────────────────────────────────────────────────────────

  function startGuide() {
    setGuideActive(true);
    setStatusText("Guide Mode active — scanning every 2 s…");
    setStatusType("ok");
    speak("Guide Mode activated.");
    guideTimer.current = setInterval(async () => {
      if (!guideRef.current || !cameraRef.current) return;
      try {
        const uri = await captureFrame();
        const data = await guideScan(uri);
        const { guidance = "", is_danger = false } = data;
        setAnswerText(guidance);
        setStatusText(is_danger ? `⚠ ${guidance}` : `Guide: ${guidance}`);
        setStatusType(is_danger ? "error" : "ok");
        if (data.audio_base64) {
          await playBase64Audio(data.audio_base64);
        } else {
          Speech.speak(guidance, { rate: is_danger ? 1.3 : 1.05 });
        }
      } catch (_) {}
    }, 2000);
  }

  function stopGuide() {
    setGuideActive(false);
    clearInterval(guideTimer.current);
    guideTimer.current = null;
    setStatusText("Guide Mode stopped.");
    setStatusType("idle");
    speak("Guide Mode stopped.");
  }

  useEffect(() => {
    return () => clearInterval(guideTimer.current);
  }, []);

  // ── sign out ──────────────────────────────────────────────────────────────

  async function handleLogout() {
    await logout();
    navigation.replace("Login");
  }

  // ── face overlay ──────────────────────────────────────────────────────────

  function FaceOverlay() {
    if (!faces.length) return null;

    // The camera feed is cropped to fill CAM_H x SCREEN_W (object-fit: cover).
    // We need to map face box coordinates (native camera resolution) to display pixels.
    // expo-camera gives us the photo dimensions via camera.takePictureAsync which we
    // don't store — so we use heuristic: assume 1280x960 native for a 4:3 feed.
    const nativeW = 1280;
    const nativeH = 960;
    const { width: dW, height: dH } = camSize;
    const scale = Math.max(dW / nativeW, dH / nativeH);
    const offsetX = (nativeW - dW / scale) / 2;
    const offsetY = (nativeH - dH / scale) / 2;

    return (
      <Svg
        style={StyleSheet.absoluteFill}
        width={dW}
        height={dH}
        pointerEvents="none"
      >
        {faces.map((face, i) => {
          const box = face.box;
          if (!box) return null;
          const x = (box.x1 - offsetX) * scale;
          const y = (box.y1 - offsetY) * scale;
          const w = box.w * scale;
          const h = box.h * scale;
          const color = face.name ? "#38bdf8" : "#f87171";
          const label = face.name
            ? `${face.name}${face.confidence ? ` ${Math.round(face.confidence * 100)}%` : ""}`
            : "Unknown";
          return (
            <React.Fragment key={i}>
              <Rect
                x={x} y={y} width={w} height={h}
                stroke={color} strokeWidth={2.5} fill="transparent"
              />
              <SvgText
                x={x + 4}
                y={y > 20 ? y - 4 : y + h + 14}
                fill={color}
                fontSize={13}
                fontWeight="bold"
              >
                {label}
              </SvgText>
            </React.Fragment>
          );
        })}
      </Svg>
    );
  }

  // ── render ────────────────────────────────────────────────────────────────

  if (!permission) return <View style={styles.root} />;
  if (!permission.granted) {
    return (
      <View style={[styles.root, styles.center]}>
        <Text style={styles.permText}>Camera permission required.</Text>
        <TouchableOpacity style={styles.permBtn} onPress={requestPermission}>
          <Text style={styles.btnText}>Grant Permission</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const dotColor =
    statusType === "working" ? "#facc15"
      : statusType === "ok"    ? "#4ade80"
      : statusType === "error" ? "#f87171"
      : "#475569";

  return (
    <View style={styles.root}>
      {/* Top bar */}
      <View style={styles.topbar}>
        <View>
          <Text style={styles.appTitle}>EchoGuide</Text>
          {username ? <Text style={styles.userText}>Hi, {username}</Text> : null}
        </View>
        <TouchableOpacity onPress={handleLogout}>
          <Text style={styles.logoutText}>Sign out</Text>
        </TouchableOpacity>
      </View>

      {/* Camera */}
      <View style={[styles.cameraCard, { height: CAM_H }]} onLayout={onCamLayout}>
        <CameraView
          ref={cameraRef}
          style={StyleSheet.absoluteFill}
          facing="back"
        />
        <FaceOverlay />
        {busy && (
          <View style={styles.scanOverlay}>
            <ActivityIndicator size="large" color="#38bdf8" />
          </View>
        )}
      </View>

      {/* Status bar */}
      <View style={styles.statusBar}>
        <View style={[styles.statusDot, { backgroundColor: dotColor }]} />
        <Text style={styles.statusText} numberOfLines={1}>{statusText}</Text>
      </View>

      {/* Action buttons */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.btnRow} contentContainerStyle={styles.btnRowInner}>
        <ActionBtn label="Scan" icon="👁" onPress={handleScanScene} busy={busy} color="#2d8cff" />
        <ActionBtn label="Read Text" icon="📄" onPress={handleReadText} busy={busy} color="#0ea5e9" />
        <ActionBtn label="Identify" icon="🧑" onPress={handleIdentify} busy={busy} color="#8b5cf6" />
        <ActionBtn label="Remember" icon="💡" onPress={handleRemember} busy={busy} color="#ec4899" />
        <ActionBtn
          label={guideActive ? "Stop Guide" : "Guide Mode"}
          icon={guideActive ? "🛑" : "🧭"}
          onPress={guideActive ? stopGuide : startGuide}
          busy={false}
          color={guideActive ? "#ef4444" : "#22c55e"}
        />
      </ScrollView>

      {/* Result */}
      <ScrollView style={styles.resultBox} contentContainerStyle={styles.resultContent}>
        <Text style={styles.resultLabel}>AI Response</Text>
        <Text style={styles.resultText}>{answerText}</Text>
      </ScrollView>
    </View>
  );
}

// ── Reusable action button ────────────────────────────────────────────────────

function ActionBtn({ label, icon, onPress, busy, color }) {
  return (
    <TouchableOpacity
      style={[styles.actionBtn, { borderColor: color, opacity: busy ? 0.5 : 1 }]}
      onPress={onPress}
      disabled={busy}
      activeOpacity={0.7}
    >
      <Text style={styles.actionIcon}>{icon}</Text>
      <Text style={[styles.actionLabel, { color }]}>{label}</Text>
    </TouchableOpacity>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#060a12" },
  center: { justifyContent: "center", alignItems: "center" },
  permText: { color: "#e2eeff", fontSize: 16, marginBottom: 16, textAlign: "center", paddingHorizontal: 24 },
  permBtn: { backgroundColor: "#2d8cff", borderRadius: 12, paddingHorizontal: 28, paddingVertical: 12 },

  topbar: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 18,
    paddingTop: Platform.OS === "ios" ? 52 : 16,
    paddingBottom: 10,
  },
  appTitle: { color: "#e2eeff", fontSize: 20, fontWeight: "700" },
  userText: { color: "#64748b", fontSize: 12, marginTop: 2 },
  logoutText: { color: "#64748b", fontSize: 13 },

  cameraCard: {
    width: "100%",
    overflow: "hidden",
    position: "relative",
    backgroundColor: "#000",
  },
  scanOverlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "rgba(6,10,18,0.35)",
  },

  statusBar: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 8,
    backgroundColor: "rgba(17,24,39,0.8)",
  },
  statusDot: { width: 8, height: 8, borderRadius: 4, marginRight: 8 },
  statusText: { color: "#94a3b8", fontSize: 13, flex: 1 },

  btnRow: { maxHeight: 90 },
  btnRowInner: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 10,
    flexDirection: "row",
    alignItems: "center",
  },
  actionBtn: {
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 14,
    borderWidth: 1.5,
    backgroundColor: "rgba(17,24,39,0.7)",
    minWidth: 80,
  },
  actionIcon: { fontSize: 22, marginBottom: 4 },
  actionLabel: { fontSize: 11, fontWeight: "700" },

  resultBox: { flex: 1, paddingHorizontal: 16, paddingTop: 8 },
  resultContent: { paddingBottom: 24 },
  resultLabel: {
    color: "#38bdf8",
    fontSize: 11,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.8,
    marginBottom: 6,
  },
  resultText: { color: "#e2eeff", fontSize: 15, lineHeight: 22 },

  btnText: { color: "#fff", fontWeight: "700", fontSize: 15 },
});
