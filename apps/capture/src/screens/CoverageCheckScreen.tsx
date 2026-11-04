import type { ReactElement } from 'react';
import { Button, Text, View } from 'react-native';

/** DMS-014: before a room is done, ask for any wall or corner that was never faced. */
export function CoverageCheckScreen(props: { onContinue: () => void }): ReactElement {
  return (
    <View>
      <Text accessibilityRole="header">Coverage check</Text>
      <Text>Placeholder: shows any wall that was never faced, and asks you to film it first.</Text>
      <Button title="Continue" onPress={props.onContinue} />
    </View>
  );
}
