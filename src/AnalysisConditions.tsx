import {
  CONDITION_REVIEW_VERSION,
  defaultConditions,
  priceConditionLabel,
  type Condition,
  type ConditionGroup,
  type ConditionNode,
  type ConditionOperator,
  type ConditionReview,
} from "../server/analysis/conditions";

function nextId(root: ConditionGroup) {
  const ids = new Set<string>();
  function walk(node: ConditionNode) {
    ids.add(node.id);
    if ("children" in node) node.children.forEach(walk);
  }
  walk(root);
  let index = 1;
  while (ids.has("C" + index)) index++;
  return "C" + index;
}

export function AnalysisConditions({
  value,
  onChange,
}: {
  value?: ConditionGroup;
  onChange: (value?: ConditionGroup) => void;
}) {
  const current = value || defaultConditions();
  const legacy = current.evaluation !== "sequence";
  function update(id: string, patch: Partial<Condition>) {
    onChange({
      ...current,
      children: current.children.map((node) => (node.id === id ? { ...node, ...patch } : node)),
    });
  }
  function add() {
    onChange({
      ...current,
      children: [
        ...current.children,
        {
          id: nextId(current),
          text: "",
          join: "and",
        },
      ],
    });
  }
  function remove(id: string) {
    const children = current.children.filter((node) => node.id !== id);
    onChange(children.length ? { ...current, children } : undefined);
  }
  function convertLegacy() {
    const children: Condition[] = [];
    function walk(group: ConditionGroup) {
      for (const node of group.children) {
        if ("children" in node) walk(node);
        else children.push({ ...node, join: group.operator });
      }
    }
    walk(current);
    onChange({ ...current, evaluation: "sequence", children });
  }
  return (
    <section className="analysis-settings-section" aria-label="入榜条件设置">
      <h3>入榜条件</h3>
      <p>从上到下按“且／或”依次计算，最终满足才入榜。价格“不限制”不参与计算。</p>
      <p>保存后开始分析，逐条查看 true／false、原始数值和计算过程；资料不足时显示“无法判断”。</p>
      {legacy ? (
        <>
          <p role="status">
            当前保存的是旧版条件组。转换后会去掉括号，按列表顺序计算；请核对每条“且／或”后保存。
          </p>
          <ConditionReviewView review={{ tree: current, results: [] }} />
          <button type="button" onClick={convertLegacy}>
            转换为单层条件列表
          </button>
        </>
      ) : (
        <>
          {!value && <p className="analysis-pending-note">未自定义时，默认：价格不限制。</p>}
          <ol className="analysis-condition-list">
            {current.children.map((entry, index) => {
              const node = entry as Condition;
              return (
                <li key={node.id}>
                  {index > 0 && (
                    <label className="analysis-condition-join">
                      与前面结果的关系
                      <select
                        aria-label={`${node.id}连接关系`}
                        value={node.join || "and"}
                        onChange={(event) =>
                          update(node.id, { join: event.target.value as ConditionOperator })
                        }
                      >
                        <option value="and">且（两者都满足）</option>
                        <option value="or">或（任一满足）</option>
                      </select>
                    </label>
                  )}
                  <div className="analysis-condition-row">
                    <div className="analysis-condition-toolbar">
                      <strong>条件 {index + 1}</strong>
                      <label>
                        条件类型{" "}
                        <select
                          aria-label={`${node.id}条件类型`}
                          value={node.price ? "price" : "text"}
                          onChange={(event) =>
                            update(
                              node.id,
                              event.target.value === "price"
                                ? {
                                    text: "",
                                    rule: undefined,
                                    price: (defaultConditions().children[0] as Condition).price,
                                  }
                                : { price: undefined, text: "", rule: undefined },
                            )
                          }
                        >
                          <option value="price">挂牌价与裸号估值比较</option>
                          <option value="text">文字条件</option>
                        </select>
                      </label>
                      <button
                        type="button"
                        aria-label={`删除条件 ${index + 1}`}
                        onClick={() => remove(node.id)}
                      >
                        删除
                      </button>
                    </div>
                    {node.price ? (
                      <div className="analysis-price-condition">
                        <select
                          aria-label={`${node.id}价格比较`}
                          value={
                            ["none", "lt", "gt"].includes(node.price.comparison) &&
                            node.price.adjustment === "none"
                              ? node.price.comparison
                              : "legacy"
                          }
                          onChange={(event) =>
                            update(node.id, {
                              price: {
                                comparison: event.target.value as "none" | "lt" | "gt",
                                adjustment: "none",
                                unit: "amount",
                                value: 0,
                              },
                            })
                          }
                        >
                          <option value="none">不限制</option>
                          <option value="lt">挂牌价小于裸号估值</option>
                          <option value="gt">挂牌价大于裸号估值</option>
                          {(!["none", "lt", "gt"].includes(node.price.comparison) ||
                            node.price.adjustment !== "none") && (
                            <option value="legacy" hidden>
                              历史条件：{priceConditionLabel(node.price)}
                            </option>
                          )}
                        </select>
                        <p className="analysis-condition-summary">
                          {priceConditionLabel(node.price)}
                        </p>
                      </div>
                    ) : (
                      <div>
                        <label>
                          条件内容
                          <textarea
                            aria-label={`${node.id}条件`}
                            maxLength={1000}
                            value={node.text}
                            placeholder="例如：速度大于800"
                            onChange={(event) =>
                              update(node.id, { text: event.target.value, rule: undefined })
                            }
                          />
                        </label>
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
          <div className="analysis-condition-actions">
            <button
              className="analysis-button analysis-button-outline"
              type="button"
              disabled={current.children.length >= 59}
              onClick={() => add()}
            >
              添加条件
            </button>
            {value && (
              <button type="button" onClick={() => onChange(undefined)}>
                恢复默认入榜条件
              </button>
            )}
          </div>
        </>
      )}
    </section>
  );
}

const labels = { met: "满足（true）", unmet: "不满足（false）", unknown: "无法判断" };
export function ConditionReviewView({ review }: { review?: ConditionReview }) {
  if (!review)
    return (
      <section>
        <h3>条件匹配</h3>
        <p>本次未配置条件</p>
      </section>
    );
  const results = new Map(review.results.map((result) => [result.id, result]));
  function render(node: ConditionNode, index = 0) {
    const result = results.get(node.id);
    const title =
      "children" in node
        ? node.evaluation === "sequence"
          ? "最终结果（从上到下计算）"
          : node.operator === "and"
            ? "全部满足（且）"
            : "任意满足（或）"
        : `条件 ${index + 1} ${node.price ? priceConditionLabel(node.price) : node.text}`;
    const description = (
      <>
        <strong>
          {title}：
          {result?.skipped ? "不限制（已跳过）" : result ? labels[result.status] : "无法判断"}
        </strong>
        <p>{result?.reason || "缺少判断结果"}</p>
        {!!result?.evidence?.length && (
          <details className="analysis-condition-evidence">
            <summary>查看采集依据（{result.evidence.length}项）</summary>
            <dl>
              {result.evidence.map((entry, index) => (
                <div key={`${entry.path}:${index}`}>
                  <dt>{entry.label}</dt>
                  <dd>
                    {entry.value === null
                      ? "未提供"
                      : Array.isArray(entry.value)
                        ? entry.value.join("、") || "空"
                        : typeof entry.value === "boolean"
                          ? entry.value
                            ? "是"
                            : "否"
                          : String(entry.value)}
                  </dd>
                </div>
              ))}
            </dl>
          </details>
        )}
      </>
    );
    return "children" in node ? (
      <details key={node.id} open className="analysis-condition-group">
        <summary>
          {title}：
          {result?.skipped ? "不限制（已跳过）" : result ? labels[result.status] : "无法判断"}
        </summary>
        <p>{result?.reason}</p>
        {node.children.map((child, index) => (
          <div key={child.id}>
            {index > 0 && (
              <strong className="analysis-condition-join">
                {(node.evaluation === "sequence" ? child.join : node.operator) === "or"
                  ? "或"
                  : "且"}
              </strong>
            )}
            {render(child, index)}
          </div>
        ))}
      </details>
    ) : (
      <div key={node.id} className="analysis-condition-row">
        {description}
      </div>
    );
  }
  return (
    <section aria-label="条件匹配">
      <h3>条件匹配</h3>
      {review.engineVersion !== CONDITION_REVIEW_VERSION && (
        <p role="status" className="analysis-pending-note">
          历史条件记录，不作为当前入榜依据；当前榜单会按保存的条件重新判断。
        </p>
      )}
      {render(review.tree)}
    </section>
  );
}
