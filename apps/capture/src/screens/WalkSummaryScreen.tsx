import { summariseWalk, type PhoneWalk } from '@domesday/capture-core';
import type { ReactElement } from 'react';
import { Text, View } from 'react-native';

/** Part 5 ("End the walk"): rooms filmed, rooms skipped with reasons, and total size. */
export function WalkSummaryScreen(props: { walk: PhoneWalk }): ReactElement {
  const summary = summariseWalk(props.walk);
  return (
    <View>
      <Text accessibilityRole="header">Walk summary</Text>
      <Text>Rooms filmed: {summary.filmed.length}</Text>
      <Text>Rooms skipped: {summary.skipped.length}</Text>
      <Text>Rooms not started: {summary.notStarted.length}</Text>
      <Text>Uploads wait for Wi-Fi unless you allow mobile data.</Text>
    </View>
  );
}
