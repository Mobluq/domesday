import { estimatePreWalk, type PhoneWalk } from '@domesday/capture-core';
import { RoomWalkStatus } from '@domesday/domain';
import type { ReactElement } from 'react';
import { Button, FlatList, Text, View } from 'react-native';

/** DMS-010: the room list with each room's status. DMS-019: the storage and battery check before the walk. */
export function RoomListScreen(props: {
  walk: PhoneWalk;
  onStartWalk: () => void;
  onFilmRoom: (roomId: string) => void;
  onEndWalk: () => void;
}): ReactElement {
  // Placeholder device readings; the app will read them from the phone.
  const estimate = estimatePreWalk({
    freeStorageBytes: 8_000_000_000,
    batteryPercent: 80,
    charging: false,
    plannedRooms: props.walk.rooms.length,
  });
  return (
    <View>
      <Text accessibilityRole="header">Rooms</Text>
      <Text>About {estimate.roomsThatFit} rooms will fit in storage and battery.</Text>
      {props.walk.phase === 'planned' && <Button title="Start walk" onPress={props.onStartWalk} />}
      <FlatList
        data={props.walk.rooms}
        keyExtractor={(room) => room.roomId}
        renderItem={({ item }) => (
          <View>
            <Text>
              {item.name}: {RoomWalkStatus.label(item.status)}
            </Text>
            {props.walk.phase === 'in_progress' && item.status !== 'skipped' && (
              <Button title="Film" onPress={() => props.onFilmRoom(item.roomId)} />
            )}
          </View>
        )}
      />
      {props.walk.phase === 'in_progress' && <Button title="End walk" onPress={props.onEndWalk} />}
    </View>
  );
}
