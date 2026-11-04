/** DMS-019: warn when less than 2 GB is free. Phones report storage in decimal gigabytes. */
export const LOW_STORAGE_WARNING_BYTES = 2_000_000_000;

export interface PreWalkAssumptions {
  /** 90 seconds: the top of the PRD's 45 to 90 seconds per room (Part 5), to stay on the safe side. */
  readonly secondsPerRoom: number;
  /** 60 MB per minute: the most a compressed clip may take (DMS-021 target). */
  readonly bytesPerMinute: number;
  /** 25% of the battery for a 60-minute walk (DMS-154 target). */
  readonly batteryPercentPerMinute: number;
  /** Space left free for the phone itself. Not in the PRD: a judgement call to revisit in the pilot. */
  readonly storageReserveBytes: number;
  /** Battery left at the end of the walk. Not in the PRD: a judgement call to revisit in the pilot. */
  readonly minBatteryPercentAtEnd: number;
}

export const DEFAULT_PRE_WALK_ASSUMPTIONS: PreWalkAssumptions = Object.freeze({
  secondsPerRoom: 90,
  bytesPerMinute: 60_000_000,
  batteryPercentPerMinute: 25 / 60,
  storageReserveBytes: 500_000_000,
  minBatteryPercentAtEnd: 10,
});

export interface PreWalkInput {
  readonly freeStorageBytes: number;
  /** 0 to 100. */
  readonly batteryPercent: number;
  readonly charging: boolean;
  readonly plannedRooms: number;
}

export interface PreWalkEstimate {
  /** How many rooms fit, the smaller of the storage and battery limits. */
  readonly roomsThatFit: number;
  readonly roomsThatFitStorage: number;
  /** Null while charging: the battery sets no limit. */
  readonly roomsThatFitBattery: number | null;
  readonly bytesNeeded: number;
  readonly storageWarning: boolean;
  readonly batteryWarning: boolean;
  readonly canFilmAllPlannedRooms: boolean;
}

/** DMS-019 and Part 5 principle 5: before a walk, say how many rooms will fit in storage and battery. */
export function estimatePreWalk(
  input: PreWalkInput,
  assumptions: PreWalkAssumptions = DEFAULT_PRE_WALK_ASSUMPTIONS,
): PreWalkEstimate {
  if (!(input.freeStorageBytes >= 0) || !(input.batteryPercent >= 0 && input.batteryPercent <= 100) || !(input.plannedRooms >= 0)) {
    throw new RangeError('pre-walk input out of range');
  }
  const minutesPerRoom = assumptions.secondsPerRoom / 60;
  const bytesPerRoom = minutesPerRoom * assumptions.bytesPerMinute;
  const batteryPerRoom = minutesPerRoom * assumptions.batteryPercentPerMinute;

  const usableBytes = Math.max(0, input.freeStorageBytes - assumptions.storageReserveBytes);
  const roomsThatFitStorage = Math.floor(usableBytes / bytesPerRoom);
  const roomsThatFitBattery = input.charging
    ? null
    : Math.floor(Math.max(0, input.batteryPercent - assumptions.minBatteryPercentAtEnd) / batteryPerRoom);
  const roomsThatFit = Math.min(roomsThatFitStorage, roomsThatFitBattery ?? roomsThatFitStorage);

  return {
    roomsThatFit,
    roomsThatFitStorage,
    roomsThatFitBattery,
    bytesNeeded: Math.ceil(input.plannedRooms * bytesPerRoom),
    storageWarning: input.freeStorageBytes < LOW_STORAGE_WARNING_BYTES || roomsThatFitStorage < input.plannedRooms,
    batteryWarning: roomsThatFitBattery !== null && roomsThatFitBattery < input.plannedRooms,
    canFilmAllPlannedRooms: roomsThatFit >= input.plannedRooms,
  };
}
