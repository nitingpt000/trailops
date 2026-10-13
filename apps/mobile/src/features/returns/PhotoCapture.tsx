import React, {useRef, useState} from 'react';
import {Modal, Pressable, StyleSheet, Text, View} from 'react-native';
import {Camera, useCameraDevice, useCameraPermission} from 'react-native-vision-camera';
import {X} from 'lucide-react-native';
import {persistPhoto, type CapturedPhoto} from '../../sync/attachments';
import {Banner, Button} from '../../ui/components';
import {colors, space} from '../../ui/tokens';

/** Captures one photo and immediately copies + hashes it into app-private storage. */
export function PhotoCapture({visible, onClose, onCaptured}: {
  visible: boolean; onClose: () => void; onCaptured: (p: CapturedPhoto) => void;
}) {
  const device = useCameraDevice('back');
  const {hasPermission, requestPermission} = useCameraPermission();
  const cam = useRef<Camera>(null);
  const [error, setError] = useState<string | null>(null);
  React.useEffect(() => {
    if (visible && !hasPermission) requestPermission();
  }, [visible, hasPermission, requestPermission]);
  return (
    <Modal visible={visible} onRequestClose={onClose} animationType="slide">
      <View style={{flex: 1, backgroundColor: '#000'}}>
        {device && hasPermission ? (
          <Camera ref={cam} style={StyleSheet.absoluteFill} device={device} isActive={visible} photo />
        ) : null}
        <View style={{flex: 1, justifyContent: 'space-between', padding: space.l, paddingTop: space.xxl}}>
          <Pressable accessibilityRole="button" accessibilityLabel="Close camera" onPress={onClose} style={{alignSelf: 'flex-end', padding: 8}}>
            <X color="#fff" size={28} />
          </Pressable>
          {!hasPermission ? <Banner tone="warning" title="Camera permission needed">Allow camera access to attach evidence.</Banner> : null}
          {error ? <Banner tone="error" title="Photo was not saved">{error}</Banner> : null}
          <View style={{gap: space.s}}>
            <Text style={{color: '#fff', textAlign: 'center'}}>Photograph the damage clearly</Text>
            <Button testID="take-photo" title="Take photo" disabled={!device || !hasPermission} onPress={async () => {
              setError(null);
              try {
                const shot = await cam.current!.takePhoto({flash: 'off'});
                const saved = await persistPhoto(shot.path);
                onCaptured(saved);
                onClose();
              } catch (e) {
                // Photo-file write failure is shown separately from form errors (spec §7).
                setError(String((e as Error)?.message ?? e));
              }
            }} />
          </View>
        </View>
      </View>
    </Modal>
  );
}

export const captureColors = colors;
