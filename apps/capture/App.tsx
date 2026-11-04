import { applyWalkEvent, type PhoneWalk, type WalkEvent } from '@domesday/capture-core';
import { useState, type ReactElement } from 'react';
import { StyleSheet, View } from 'react-native';
import { CoverageCheckScreen } from './src/screens/CoverageCheckScreen';
import { FilmingScreen } from './src/screens/FilmingScreen';
import { RoomListScreen } from './src/screens/RoomListScreen';
import { WalkSummaryScreen } from './src/screens/WalkSummaryScreen';
import { sampleWalk } from './src/sampleWalk';
import { colours } from './src/theme';

type Screen = { name: 'rooms' } | { name: 'filming'; roomId: string } | { name: 'coverage'; roomId: string } | { name: 'summary' };

/** Placeholder navigation between the four screens. The walk state machine lives in @domesday/capture-core. */
export function App(): ReactElement {
  const [walk, setWalk] = useState<PhoneWalk>(() => sampleWalk());
  const [screen, setScreen] = useState<Screen>({ name: 'rooms' });

  const dispatch = (event: WalkEvent): boolean => {
    const result = applyWalkEvent(walk, event);
    if (result.ok) setWalk(result.walk);
    return result.ok;
  };

  return (
    <View style={styles.root}>
      {screen.name === 'rooms' && (
        <RoomListScreen
          walk={walk}
          onStartWalk={() => dispatch({ type: 'start_walk' })}
          onFilmRoom={(roomId) => setScreen({ name: 'filming', roomId })}
          onEndWalk={() => dispatch({ type: 'end_walk' }) && setScreen({ name: 'summary' })}
        />
      )}
      {screen.name === 'filming' && <FilmingScreen onDone={() => setScreen({ name: 'coverage', roomId: screen.roomId })} />}
      {screen.name === 'coverage' && <CoverageCheckScreen onContinue={() => setScreen({ name: 'rooms' })} />}
      {screen.name === 'summary' && <WalkSummaryScreen walk={walk} />}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colours['surface'] },
});
