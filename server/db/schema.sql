-- Kumbh-a-Mitra — production data model (Postgres 15+ / PostGIS 3)
-- The dev JSON store in store.js mirrors these tables one-for-one.
-- Run this when you graduate off the file store.

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------- identity --
-- Guest is a first-class path: phone may be null forever.
CREATE TABLE app_user (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name    text        NOT NULL,
  phone_e164      text        UNIQUE,
  phone_verified  boolean     NOT NULL DEFAULT false,
  role            text        NOT NULL DEFAULT 'pilgrim'
                    CHECK (role IN ('pilgrim','volunteer','admin')),
  language        text        NOT NULL DEFAULT 'hi',
  device_token    text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz
);

-- ------------------------------------------------------------------ groups --
CREATE TABLE travel_group (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text        NOT NULL,
  join_code   char(6)     NOT NULL UNIQUE,   -- printed on wristbands as a QR
  created_by  uuid        NOT NULL REFERENCES app_user(id),
  meeting_point_id text,                     -- node id on the mela graph
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL           -- groups die with the event
);

CREATE TABLE group_member (
  group_id   uuid NOT NULL REFERENCES travel_group(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  label      text,                            -- "Dadi", "Arjun (8)"
  sharing    boolean NOT NULL DEFAULT true,   -- opt-in, revocable any time
  joined_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, user_id)
);

-- Latest position only. Deliberately NOT a history table: keeping a movement
-- trail for every pilgrim is a stalking risk with no operational payoff.
CREATE TABLE user_position (
  user_id     uuid PRIMARY KEY REFERENCES app_user(id) ON DELETE CASCADE,
  geom        geography(Point, 4326) NOT NULL,
  geohash6    text NOT NULL,                  -- ~1.2km cell, what we log
  node_id     text,                           -- nearest landmark on the graph
  accuracy_m  integer,
  battery_pct smallint,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX user_position_geom_idx ON user_position USING GIST (geom);

-- --------------------------------------------------------------------- sos --
CREATE TABLE sos_alert (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key  text        NOT NULL UNIQUE,  -- minted on device, pre-network
  user_id          uuid        REFERENCES app_user(id),
  group_id         uuid        REFERENCES travel_group(id),
  kind             text        NOT NULL
                     CHECK (kind IN ('lost_person','lost_self','medical','crowd_crush','other')),
  note             text,
  subject_label    text,                         -- who is missing
  geom             geography(Point, 4326),
  node_id          text,
  status           text        NOT NULL DEFAULT 'open'
                     CHECK (status IN ('open','claimed','resolved','cancelled')),
  claimed_by       uuid        REFERENCES app_user(id),
  claimed_at       timestamptz,
  claim_expires_at timestamptz,                  -- auto-unclaim, see routes/sos.js
  resolved_at      timestamptz,
  resolution       text,
  raised_at        timestamptz NOT NULL,         -- device clock, when button pressed
  received_at      timestamptz NOT NULL DEFAULT now()  -- server clock
);
CREATE INDEX sos_open_idx ON sos_alert (status, received_at DESC)
  WHERE status IN ('open','claimed');
CREATE INDEX sos_geom_idx ON sos_alert USING GIST (geom);

-- Append-only. Never updated, never deleted. This is the record you will be
-- asked for if something goes wrong.
CREATE TABLE sos_event (
  id         bigserial PRIMARY KEY,
  alert_id   uuid NOT NULL REFERENCES sos_alert(id) ON DELETE CASCADE,
  kind       text NOT NULL,   -- queued_on_device | received | claimed | unclaimed
                              -- | resolved | cancelled | escalated
  actor_id   uuid REFERENCES app_user(id),
  detail     jsonb NOT NULL DEFAULT '{}',
  at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sos_event_alert_idx ON sos_event (alert_id, at);

-- ------------------------------------------------------------ mela routing --
-- The walkable graph is static content shipped with the app. Only the crowd
-- level is live, and it is tiny — which is what makes it syncable on a dead
-- network.
CREATE TABLE route_edge_flag (
  edge_id    text PRIMARY KEY,
  level      smallint NOT NULL CHECK (level BETWEEN 1 AND 4), -- 1 clear .. 4 closed
  source     text     NOT NULL DEFAULT 'admin',  -- admin | cctv | device_density
  set_by     uuid REFERENCES app_user(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE notice (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  severity   text NOT NULL CHECK (severity IN ('info','warning','urgent')),
  body_i18n  jsonb NOT NULL,        -- { "hi": "...", "en": "...", "mr": "..." }
  starts_at  timestamptz NOT NULL DEFAULT now(),
  ends_at    timestamptz,
  created_by uuid REFERENCES app_user(id)
);

CREATE TABLE schedule_event (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title_i18n  jsonb NOT NULL,
  node_id     text,
  starts_at   timestamptz NOT NULL,
  ends_at     timestamptz,
  crowd_hint  smallint
);
