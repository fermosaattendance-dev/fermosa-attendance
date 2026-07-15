import { CameraView, useCameraPermissions } from 'expo-camera';
import { SaveFormat, manipulateAsync } from 'expo-image-manipulator';
import { useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

interface Props {
  title: string;
  /** base64 jpeg (no data: prefix), or null when the user proceeds without a camera. */
  onCapture: (selfieB64: string | null) => void;
  onCancel: () => void;
}

/**
 * Front-camera selfie capture. By product decision a punch must NEVER be
 * blocked by the camera: permission denied or hardware failure offers a
 * "continue without selfie" path (the punch gets flagged for HR instead).
 */
export function SelfieCamera({ title, onCapture, onCancel }: Props) {
  const [permission, requestPermission] = useCameraPermissions();
  const [busy, setBusy] = useState(false);
  const [cameraBroken, setCameraBroken] = useState(false);
  const cameraRef = useRef<CameraView>(null);

  const takeSelfie = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const photo = await cameraRef.current?.takePictureAsync({ quality: 0.7 });
      if (!photo?.uri) throw new Error('no photo');
      const compressed = await manipulateAsync(photo.uri, [{ resize: { width: 640 } }], {
        compress: 0.55,
        format: SaveFormat.JPEG,
        base64: true,
      });
      onCapture(compressed.base64 ?? null);
    } catch {
      setCameraBroken(true);
      setBusy(false);
    }
  };

  if (!permission) {
    return (
      <View style={styles.center}>
        <ActivityIndicator />
      </View>
    );
  }

  const showFallback = cameraBroken || (!permission.granted && !permission.canAskAgain);

  if (showFallback || !permission.granted) {
    return (
      <View style={styles.center}>
        <Text style={styles.title}>{title}</Text>
        <Text style={styles.note}>
          {showFallback
            ? 'The camera is unavailable. You can continue — the punch will be marked “no selfie” and HR will review it.'
            : 'A quick selfie is required as attendance proof.'}
        </Text>
        {!showFallback && (
          <Pressable style={styles.primaryBtn} onPress={requestPermission}>
            <Text style={styles.primaryText}>Allow camera</Text>
          </Pressable>
        )}
        <Pressable style={styles.secondaryBtn} onPress={() => onCapture(null)}>
          <Text style={styles.secondaryText}>Continue without selfie</Text>
        </Pressable>
        <Pressable style={styles.linkBtn} onPress={onCancel}>
          <Text style={styles.linkText}>Cancel</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <CameraView ref={cameraRef} style={styles.camera} facing="front" />
      <View style={styles.overlay}>
        <Text style={styles.overlayTitle}>{title}</Text>
        <Pressable style={styles.shutter} onPress={takeSelfie} disabled={busy}>
          {busy ? <ActivityIndicator color="#fff" /> : <View style={styles.shutterInner} />}
        </Pressable>
        <Pressable style={styles.linkBtn} onPress={onCancel} disabled={busy}>
          <Text style={[styles.linkText, { color: '#fff' }]}>Cancel</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  camera: { flex: 1 },
  overlay: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    alignItems: 'center',
    paddingBottom: 40,
    gap: 12,
  },
  overlayTitle: { color: '#fff', fontSize: 17, fontWeight: '600', marginBottom: 6 },
  shutter: {
    width: 72,
    height: 72,
    borderRadius: 36,
    borderWidth: 4,
    borderColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  shutterInner: { width: 54, height: 54, borderRadius: 27, backgroundColor: '#fff' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 28, gap: 14, backgroundColor: '#f9fafb' },
  title: { fontSize: 19, fontWeight: '600', color: '#111827' },
  note: { fontSize: 14, color: '#6b7280', textAlign: 'center', lineHeight: 21 },
  primaryBtn: { backgroundColor: '#F5C518', borderRadius: 12, paddingVertical: 13, paddingHorizontal: 26 },
  primaryText: { color: '#3A2D06', fontSize: 15, fontWeight: '700' },
  secondaryBtn: { borderWidth: 1, borderColor: '#d1d5db', borderRadius: 12, paddingVertical: 13, paddingHorizontal: 26 },
  secondaryText: { color: '#374151', fontSize: 15 },
  linkBtn: { padding: 8 },
  linkText: { fontSize: 14, color: '#6b7280' },
});
