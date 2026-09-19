import type { DetailItem } from "../server/crawler/types";

export function RoleItems({ items }: { items: DetailItem[] }) {
  if (!items.length) return <p className="status-note">无已记录装备</p>;
  return (
    <div className="detail-items">
      {items.map((item, index) => (
        <article key={index} className="detail-item">
          <h5>
            {item.name}
            {item.level && (
              <span>
                {" "}
                · {item.level}
                {item.kind === "innerSkill" ? "层" : "级"}
              </span>
            )}
          </h5>
          {item.category && <p className="status-note">{item.category}</p>}
          {item.kind !== "skill" && item.kind !== "innerSkill" && item.description && (
            <pre className="tab-content">{item.description}</pre>
          )}
          {item.attributes && (
            <dl>
              {Object.entries(item.attributes)
                .filter(([key]) => !/[a-z_]/i.test(key))
                .map(([key, value]) => (
                  <div key={key}>
                    <dt>{key}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
            </dl>
          )}
        </article>
      ))}
    </div>
  );
}
