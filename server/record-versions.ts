import type { DatabaseSync } from "node:sqlite";

const records = {
  listings: {
    key: "key",
    fields: ["listing_json", "detail_json", "status", "collected_at"],
  },
  analysis_tasks: {
    key: "id",
    fields: [
      "result_json",
      "source_listing_json",
      "source_detail_json",
      "status",
      "error",
      "source_task_id",
      "equipment_pricing_json",
      "pet_pricing_json",
    ],
  },
  analysis_attempts: {
    key: "id",
    fields: ["state", "raw_response", "finished_at"],
  },
} as const;

/** Small, durable identities for changed inputs, including writes from other connections. */
export function trackRecordVersions(db: DatabaseSync, entity: keyof typeof records) {
  const { key, fields } = records[entity];
  db.exec(`CREATE TABLE IF NOT EXISTS record_versions (
    revision INTEGER PRIMARY KEY AUTOINCREMENT, entity TEXT NOT NULL, record_key TEXT NOT NULL,
    UNIQUE(entity,record_key)
  );
  CREATE TRIGGER IF NOT EXISTS ${entity}_version_insert AFTER INSERT ON ${entity} BEGIN
    DELETE FROM record_versions WHERE entity='${entity}' AND record_key=NEW.${key};
    INSERT INTO record_versions(entity,record_key) VALUES('${entity}',NEW.${key});
  END;
  CREATE TRIGGER IF NOT EXISTS ${entity}_version_update AFTER UPDATE OF ${fields.join(",")} ON ${entity}
  WHEN ${fields.map((field) => `OLD.${field} IS NOT NEW.${field}`).join(" OR ")} BEGIN
    DELETE FROM record_versions WHERE entity='${entity}' AND record_key=NEW.${key};
    INSERT INTO record_versions(entity,record_key) VALUES('${entity}',NEW.${key});
  END;
  CREATE TRIGGER IF NOT EXISTS ${entity}_version_delete AFTER DELETE ON ${entity} BEGIN
    DELETE FROM record_versions WHERE entity='${entity}' AND record_key=OLD.${key};
  END;
  INSERT INTO record_versions(entity,record_key)
    SELECT '${entity}',${key} FROM ${entity} source
    WHERE NOT EXISTS(SELECT 1 FROM record_versions v WHERE v.entity='${entity}' AND v.record_key=source.${key});`);
}
