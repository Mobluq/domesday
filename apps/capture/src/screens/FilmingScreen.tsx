import { UI_COPY } from '@domesday/domain';
import type { ReactElement } from 'react';
import { Button, StyleSheet, Text, View } from 'react-native';
import { colours } from '../theme';

/** DMS-103: a red recording indicator and the words "Recording spaces for asset count" while recording. */
export function FilmingScreen(props: { onDone: () => void }): ReactElement {
  return (
    <View>
      <View style={styles.indicator} accessibilityLabel="Recording" />
      <Text>{UI_COPY.recordingNotice}</Text>
      <Text>Placeholder: the camera view, live prompts and the label shot button go here.</Text>
      <Button title="Done" onPress={props.onDone} />
    </View>
  );
}

const styles = StyleSheet.create({
  indicator: { width: 16, height: 16, borderRadius: 8, backgroundColor: colours['camera-record'] },
});
