-- Reverses 0005.
DROP TABLE label_shots;
DROP TABLE upload_sessions;
DROP TABLE clips;
DROP FUNCTION clips_guard();
DROP TABLE walk_rooms;
ALTER TABLE rooms DROP CONSTRAINT rooms_created_during_walk_fk;
DROP TABLE walks;
