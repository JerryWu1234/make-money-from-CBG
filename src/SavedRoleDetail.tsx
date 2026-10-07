import { useEffect, useState } from "react";
import type { SavedRoleRecord } from "../server/crawler/types";
import { CAPTURE_VERSION } from "../server/crawler/compact";
import { RoleItems } from "./RoleItems";
import { detailFields } from "./detail-view";
import { displayTime } from "./SavedRoleList";

export function SavedRoleDetail({ recordKey, running }: { recordKey: string; running: boolean }) {
  const [record, setRecord] = useState<SavedRoleRecord | null>(null);
  const [error, setError] = useState("");
  const [selectedTab, setSelectedTab] = useState(-1);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      let again = true;
      try {
        const response = await fetch(`/api/crawl/detail?key=${encodeURIComponent(recordKey)}`, {
          cache: "no-store",
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]),
        });
        if (!response.ok) throw new Error("无法读取已保存详情，正在重试…");
        const data: SavedRoleRecord | null = await response.json();
        if (controller.signal.aborted) return;
        if (!data) throw new Error("未找到商品记录");
        setRecord(data);
        setError("");
        // pending 是正在读取详情的中间状态；不要把第一次请求的 null 固定在界面上。
        again = data.status === "pending" || (running && data.status === "failed");
      } catch (e) {
        if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "详情读取失败");
      } finally {
        if (!controller.signal.aborted && again) timer = setTimeout(() => void refresh(), 1500);
      }
    };
    void refresh();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [recordKey, running]);
  const tabs = record?.detail?.tabs || [];
  const tab = tabs[selectedTab];
  const summary =
    record?.listing.summary && typeof record.listing.summary === "object"
      ? (record.listing.summary as Record<string, unknown>)
      : {};
  const value = (key: string) =>
    typeof summary[key] === "string" || typeof summary[key] === "number"
      ? String(summary[key])
      : "未采集";
  const roleTab = tabs.find((entry) => entry.name === "人物/修炼");
  const server =
    record?.listing.serverName ||
    roleTab?.fields.find((field) => field.name === "服务器")?.value.split(/\s+ID[：:]/)[0] ||
    (record?.listing.serverId ? `服务器 ${record.listing.serverId}` : "未记录服务器");
  const school = roleTab
    ? detailFields(roleTab).find((field) => field.name === "门派")?.value
    : undefined;
  const petTab = tabs.find((entry) => entry.pets);
  const fields = tab ? detailFields(tab) : [];
  const navigation = ["估价概览", ...tabs.map((entry) => entry.name)];
  return (
    <section className="saved-role" aria-label="已保存的角色详情">
      {error && (
        <p role="alert" className="detail-notice notice-warning">
          {error}
        </p>
      )}
      {!record && (
        <p role="status" className="detail-loading">
          正在读取已保存数据…
        </p>
      )}
      {record && (
        <>
          <div className="role-hero">
            <div>
              <span
                className={`record-badge ${record.status === "complete" ? "record-complete" : "record-pending"}`}
              >
                {record.status === "complete"
                  ? record.detail?.valuation?.issues.length
                    ? "估值资料待补齐"
                    : "详情已完整采集"
                  : record.status === "failed"
                    ? "详情待重试"
                    : running
                      ? "详情采集中"
                      : "详情待续采"}
              </span>
              <h3>
                {value("cName") !== "未采集" ? value("cName") : record.listing.name || "角色"}
              </h3>
              <p className="role-meta">
                {server}
                {school ? ` · ${school}` : ""} · 角色编号 {record.listing.name || "未记录"}
              </p>
            </div>
            <div className="role-price">
              <span>挂牌价格</span>
              <strong>¥{record.listing.price || "—"}</strong>
            </div>
          </div>
          <div className="role-highlights">
            {(record.listing.highlights?.length
              ? record.listing.highlights
              : typeof summary.summary === "string"
                ? [summary.summary]
                : []
            ).map((text, index) => (
              <span key={index}>{text}</span>
            ))}
          </div>
          {record.status === "pending" && (
            <p role="status" className="detail-notice">
              {running
                ? "已读取列表摘要，正在采集详情。完成后会自动显示各标签内容。"
                : "采集暂停时详情尚未完成。继续采集会优先按原商品链接补采。"}
            </p>
          )}
          {record.status === "failed" && (
            <p role="alert" className="detail-notice notice-warning">
              详情未完成：{record.error || "请继续采集重试"}
            </p>
          )}
          {record.status !== "complete" && record.detail && (
            <p className="detail-notice notice-warning">以下为上次保存的详情，本次尚未完整采集。</p>
          )}
          {!!record.detail?.valuation?.issues.length && (
            <p className="detail-notice notice-warning">
              {record.detail.valuation.issues.join("；")}
            </p>
          )}
          {record.detail && (record.detail.captureVersion ?? 0) < CAPTURE_VERSION && (
            <p className="detail-notice">
              这是旧版采集结果；开始或继续采集时会自动优先补采所需资料。
            </p>
          )}
          <div
            className="detail-tabs"
            role="tablist"
            aria-label="已采集详情标签"
            onKeyDown={(event) => {
              const index = selectedTab + 1;
              const next =
                event.key === "ArrowRight"
                  ? (index + 1) % navigation.length
                  : event.key === "ArrowLeft"
                    ? (index - 1 + navigation.length) % navigation.length
                    : event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? navigation.length - 1
                        : null;
              if (next !== null) {
                event.preventDefault();
                setSelectedTab(next - 1);
                event.currentTarget
                  .querySelectorAll<HTMLButtonElement>('[role="tab"]')
                  [next]?.focus();
              }
            }}
          >
            {navigation.map((name, index) => (
              <button
                key={index}
                id={`saved-tab-${index}`}
                role="tab"
                tabIndex={selectedTab + 1 === index ? 0 : -1}
                aria-selected={selectedTab + 1 === index}
                aria-controls="saved-tab-panel"
                onClick={() => setSelectedTab(index - 1)}
              >
                {name}
              </button>
            ))}
          </div>
          <div
            id="saved-tab-panel"
            role="tabpanel"
            tabIndex={0}
            aria-labelledby={`saved-tab-${selectedTab + 1}`}
          >
            {!tab ? (
              <>
                <div className="valuation-metrics">
                  {[
                    ["角色等级", "iGrade"],
                    ["人物总修", "xiulian"],
                    ["宠物总修", "pet_xiulian"],
                    ["成就点数", "AchPointTotal"],
                  ].map(([label, key]) => (
                    <article key={key}>
                      <span>{label}</span>
                      <strong>{value(key)}</strong>
                    </article>
                  ))}
                </div>
                <section className="overview-section">
                  <h4>估价资料清单</h4>
                  <p className="status-note">从角色底子、随身装备和召唤兽开始查看。</p>
                  <div className="detail-section-links">
                    {[
                      {
                        name: "人物/修炼",
                        label: "人物与修炼",
                        text: "基础属性、人物修炼与宠物修炼",
                      },
                      {
                        name: "道具/法宝",
                        label: "装备与法宝",
                        text: "逐件核对属性、特技、宝石和熔炼",
                      },
                      {
                        name: "召唤兽/孩子",
                        label: "召唤兽与孩子",
                        text: petTab?.pets
                          ? `已采集 ${petTab.pets.length} / ${petTab.petCount ?? petTab.pets.length} 只召唤兽`
                          : "详情未采集，数量未知",
                      },
                    ].map((entry) => {
                      const index = tabs.findIndex((tab) => tab.name === entry.name);
                      return (
                        <button
                          key={entry.name}
                          disabled={index < 0}
                          onClick={() => setSelectedTab(index)}
                        >
                          <strong>
                            {entry.label}
                            <span aria-hidden="true"> →</span>
                          </strong>
                          <span>{index < 0 ? "详情尚未完成" : entry.text}</span>
                        </button>
                      );
                    })}
                  </div>
                </section>
                {!!record.detail?.valuation?.fields.length && (
                  <section className="overview-section">
                    <h4>已核对的估值资料</h4>
                    <dl className="detail-field-grid">
                      {record.detail.valuation.fields.map((field, index) => (
                        <div key={index}>
                          <dt>{field.name}</dt>
                          <dd>{field.value}</dd>
                        </div>
                      ))}
                    </dl>
                  </section>
                )}
                <section className="overview-section">
                  <h4>采集记录</h4>
                  <dl className="detail-field-grid">
                    <div>
                      <dt>服务器</dt>
                      <dd>{server}</dd>
                    </div>
                    <div>
                      <dt>上架时间</dt>
                      <dd>{displayTime(record.listing.sellingTime)}</dd>
                    </div>
                    <div>
                      <dt>详情采集时间</dt>
                      <dd>{displayTime(record.detail?.collectedAt)}</dd>
                    </div>
                    <div>
                      <dt>已保存分类</dt>
                      <dd>{tabs.length ? `${tabs.length} 个标签及子项` : "尚未完成"}</dd>
                    </div>
                    <div className="field-wide">
                      <dt>商品编号</dt>
                      <dd>{record.listing.eid}</dd>
                    </div>
                  </dl>
                </section>
              </>
            ) : (
              <>
                <div className="detail-section-heading">
                  <h4>{tab.name}</h4>
                  <span>{fields.length ? `${fields.length} 项属性` : "已保存资料"}</span>
                </div>
                {!!fields.length && (
                  <dl className="detail-field-grid">
                    {fields.map((field, index) => (
                      <div key={index}>
                        <dt>{field.name}</dt>
                        <dd>{field.value}</dd>
                      </div>
                    ))}
                  </dl>
                )}
                {!!tab.items?.length && (
                  <section className="overview-section">
                    <h4>装备、技能与物品 · {tab.items.length} 项</h4>
                    <RoleItems items={tab.items} />
                  </section>
                )}
                {tab.pets && (
                  <section className="pet-cards" aria-label="全部召唤兽">
                    <h4>
                      召唤兽（已采集 {tab.pets.length} / {tab.petCount ?? tab.pets.length} 只）
                    </h4>
                    {!tab.pets.length && <p className="detail-empty">已采集数据中无召唤兽。</p>}
                    {tab.pets.map((pet) => (
                      <article className="pet-card" key={pet.index}>
                        <h5>
                          <span className="pet-number">{pet.index}</span>第 {pet.index} 只 ·{" "}
                          {pet.name}
                        </h5>
                        <dl className="pet-fields">
                          {pet.fields.map((field, index) => (
                            <div key={index}>
                              <dt>{field.name}</dt>
                              <dd>{field.value}</dd>
                            </div>
                          ))}
                        </dl>
                        <h6>技能（{pet.skills.length} 个）</h6>
                        <div className="skill-chips">
                          {pet.skills.map((skill, index) => (
                            <span key={index}>{skill.name}</span>
                          ))}
                          {!pet.skills.length && "无"}
                        </div>
                        <p className="pet-inner-skills">
                          <strong>内丹：</strong>
                          {pet.innerSkills
                            .map(
                              (skill) =>
                                `${skill.name}${skill.level ? `（${skill.level}层）` : ""}`,
                            )
                            .join("、") || "无"}
                        </p>
                        <h6>宝宝装备（{pet.equipment.length} 件）</h6>
                        <RoleItems items={pet.equipment} />
                      </article>
                    ))}
                  </section>
                )}
                {!!tab.tables.length && (
                  <details className="detail-supplement">
                    <summary>查看补充表格（{tab.tables.length}）</summary>
                    {tab.tables.map((table, index) => (
                      <div className="role-table-scroll" key={index}>
                        <table className="detail-data-table">
                          <tbody>
                            {table.map((row, r) => (
                              <tr key={r}>
                                {row.map((cell, c) => (
                                  <td key={c}>{cell}</td>
                                ))}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ))}
                  </details>
                )}
                {tab.text && (
                  <details
                    className="detail-supplement"
                    open={!fields.length && !tab.items?.length && !tab.pets}
                  >
                    <summary>查看补充文字</summary>
                    <div className="tab-content">{tab.text}</div>
                  </details>
                )}
                {!fields.length && !tab.items?.length && !tab.pets && !tab.text && (
                  <p className="detail-empty">该分类暂没有可展示的数据。</p>
                )}
              </>
            )}
          </div>
        </>
      )}
    </section>
  );
}
