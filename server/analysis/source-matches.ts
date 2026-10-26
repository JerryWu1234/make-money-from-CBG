import type { DatabaseSync } from "node:sqlite";

/** Exact source equality is maintained once per input write, including external writers. */
export function installSourceMatches(db: DatabaseSync) {
  const taskMatch = `coalesce((SELECT NEW.source_listing_json=l.listing_json AND NEW.source_detail_json=l.detail_json
    FROM listings l WHERE l.key=NEW.listing_key),0)`;
  const listingMatch = `coalesce((SELECT t.source_listing_json=NEW.listing_json AND t.source_detail_json=NEW.detail_json
    FROM analysis_tasks t WHERE t.id=analysis_source_matches.task_id),0)`;
  db.exec(`CREATE TABLE IF NOT EXISTS analysis_source_matches (
    task_id TEXT PRIMARY KEY, listing_key TEXT NOT NULL, matches INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS analysis_source_matches_listing ON analysis_source_matches(listing_key);
  CREATE TRIGGER IF NOT EXISTS analysis_source_match_insert AFTER INSERT ON analysis_tasks BEGIN
    DELETE FROM analysis_source_matches WHERE task_id=NEW.id;
    INSERT INTO analysis_source_matches VALUES(NEW.id,NEW.listing_key,${taskMatch});
  END;
  CREATE TRIGGER IF NOT EXISTS analysis_source_match_update AFTER UPDATE OF source_listing_json,source_detail_json,listing_key ON analysis_tasks
  WHEN OLD.source_listing_json IS NOT NEW.source_listing_json OR OLD.source_detail_json IS NOT NEW.source_detail_json OR OLD.listing_key IS NOT NEW.listing_key BEGIN
    DELETE FROM analysis_source_matches WHERE task_id=NEW.id;
    INSERT INTO analysis_source_matches VALUES(NEW.id,NEW.listing_key,${taskMatch});
  END;
  CREATE TRIGGER IF NOT EXISTS analysis_source_match_delete AFTER DELETE ON analysis_tasks BEGIN
    DELETE FROM analysis_source_matches WHERE task_id=OLD.id;
  END;
  CREATE TRIGGER IF NOT EXISTS analysis_source_listing_insert AFTER INSERT ON listings BEGIN
    UPDATE analysis_source_matches SET matches=${listingMatch} WHERE listing_key=NEW.key;
  END;
  CREATE TRIGGER IF NOT EXISTS analysis_source_listing_update AFTER UPDATE OF listing_json,detail_json ON listings
  WHEN OLD.listing_json IS NOT NEW.listing_json OR OLD.detail_json IS NOT NEW.detail_json BEGIN
    UPDATE analysis_source_matches SET matches=${listingMatch} WHERE listing_key=NEW.key;
  END;
  CREATE TRIGGER IF NOT EXISTS analysis_source_listing_delete AFTER DELETE ON listings BEGIN
    UPDATE analysis_source_matches SET matches=0 WHERE listing_key=OLD.key;
  END;
  INSERT INTO analysis_source_matches
    SELECT t.id,t.listing_key,coalesce(t.source_listing_json=l.listing_json AND t.source_detail_json=l.detail_json,0)
    FROM analysis_tasks t LEFT JOIN listings l ON l.key=t.listing_key
    WHERE NOT EXISTS(SELECT 1 FROM analysis_source_matches m WHERE m.task_id=t.id);`);
}
