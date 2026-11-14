import { useEffect, useRef, useState } from "react";
import type { AiProvider } from "../server/ai/types";
import { RULE_ENGINE_VERSION } from "../server/analysis/condition-rule-types";
import {
  comparisonLabels,
  defaultConditions,
  normalizeConditions,
  priceConditionLabel,
  type Condition,
  type ConditionGroup,
  type ConditionNode,
  type ConditionOperator,
  type ConditionReview,
  type PriceCondition,
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

function conditionInputKey(node: ConditionNode): string {
  if ("children" in node)
    return JSON.stringify({
      id: node.id,
      join: node.join,
      operator: node.operator,
      evaluation: node.evaluation,
      children: node.children.map(conditionInputKey),
    });
  return JSON.stringify({
    id: node.id,
    join: node.join,
    text: node.text.trim(),
    price: node.price,
  });
}

const ruleStatusLabels = {
  ready: "可执行",
  ambiguous: "需明确口径",
  unsupported: "暂无法自动判断",
};

export function AnalysisConditions({
  value,
  onChange,
  onCompilingChange,
  compileProvider = "codex",
  compileModel,
}: {
  value?: ConditionGroup;
  onChange: (value?: ConditionGroup) => void;
  onCompilingChange?: (compiling: boolean) => void;
  compileProvider?: AiProvider;
  compileModel?: string;
}) {
  const current = value || defaultConditions();
  const request = useRef<{ controller: AbortController; key: string; inputKey: string } | null>(
    null,
  );
  const [compiling, setCompiling] = useState(false);
  const [compileError, setCompileError] = useState<string | null>(null);
  const [compileNotice, setCompileNotice] = useState("");
  const inputKey = conditionInputKey(current);
  const currentKey = JSON.stringify([compileProvider, compileModel || null, inputKey]);
  const latestKey = useRef(currentKey);
  latestKey.current = currentKey;
  useEffect(() => {
    const active = request.current;
    if (active && active.key !== currentKey) {
      active.controller.abort();
      request.current = null;
      setCompiling(false);
      onCompilingChange?.(false);
      setCompileNotice("条件或解析服务已修改，已取消旧解析；请按当前输入重新解析。");
    }
  }, [currentKey, onCompilingChange]);
  useEffect(
    () => () => {
      request.current?.controller.abort();
      request.current = null;
      onCompilingChange?.(false);
    },
    [onCompilingChange],
  );
  async function compile() {
    if (request.current) return;
    const textNodes = current.children.filter(
      (node) => !("children" in node) && !node.price,
    ) as Condition[];
    if (textNodes.some((node) => !node.text.trim())) {
      setCompileError("请先填写每条文字条件，再解析执行口径。");
      return;
    }
    const controller = new AbortController();
    const active = { controller, key: currentKey, inputKey };
    request.current = active;
    setCompiling(true);
    onCompilingChange?.(true);
    setCompileError(null);
    setCompileNotice("");
    try {
      const response = await fetch("/api/analysis/conditions/compile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conditions: current,
          provider: compileProvider,
          ...(compileModel ? { model: compileModel } : {}),
        }),
        signal: controller.signal,
      });
      const data = await response.json();
      if (
        controller.signal.aborted ||
        request.current !== active ||
        latestKey.current !== active.key
      )
        return;
      if (!response.ok) throw new Error(data.error || "条件解析失败，请重试");
      const compiled = normalizeConditions(data.conditions);
      if (!compiled || conditionInputKey(compiled) !== active.inputKey)
        throw new Error("解析结果与当前输入不一致，请重新解析");
      for (const node of compiled.children) {
        if ("children" in node || node.price) continue;
        if (
          !node.rule ||
          node.rule.version !== RULE_ENGINE_VERSION ||
          node.rule.sourceText !== node.text.trim()
        )
          throw new Error(`${node.id} 的解析结果缺失或已过期，请重新解析`);
      }
      request.current = null;
      onChange(compiled);
      setCompileNotice("解析已完成。请核对每条执行口径，再保存设置；解析不会自动保存。");
    } catch (failure) {
      if (!controller.signal.aborted && request.current === active)
        setCompileError(failure instanceof Error ? failure.message : "条件解析失败，请重试");
    } finally {
      if (request.current === active || request.current === null) {
        if (request.current === active) request.current = null;
        setCompiling(false);
        onCompilingChange?.(false);
      }
    }
  }
  const legacy = current.evaluation !== "sequence";
  function update(id: string, patch: Partial<Condition>) {
    onChange({
      ...current,
      children: current.children.map((node) => (node.id === id ? { ...node, ...patch } : node)),
    });
  }
  function add(price = false) {
    onChange({
      ...current,
      children: [
        ...current.children,
        {
          id: nextId(current),
          text: "",
          join: "and",
          ...(price ? { price: (defaultConditions().children[0] as Condition).price } : {}),
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
      <p>
        从上到下依次计算，每一步将前面的结果与下一条按“且／或”合并。最终满足才入榜，无法判断不入榜，可在全部商品查看依据。
      </p>
      <p>
        文字可自由输入。先解析并核对执行口径，再由程序根据已采集资料计算；价格条件按分比较。不改变裸号估值公式。
      </p>
      <p>
        未解析、口径不明确或资料不足的条件不会被当作满足。只分析裸号价格时，条件仍可核对已采集的装备和宝宝资料。
      </p>
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
          {!value && (
            <p className="analysis-pending-note">未自定义时，默认：挂牌价等于裸号估值。</p>
          )}
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
                          <option value="text">自由文字条件</option>
                        </select>
                      </label>
                      <button type="button" onClick={() => remove(node.id)}>
                        删除{node.id}
                      </button>
                    </div>
                    {node.price ? (
                      <div className="analysis-price-condition">
                        <span>挂牌价</span>
                        <select
                          aria-label={`${node.id}价格比较`}
                          value={node.price.comparison}
                          onChange={(event) =>
                            update(node.id, {
                              price: {
                                ...node.price!,
                                comparison: event.target.value as PriceCondition["comparison"],
                              },
                            })
                          }
                        >
                          {Object.entries(comparisonLabels).map(([key, label]) => (
                            <option key={key} value={key}>
                              {label}
                            </option>
                          ))}
                        </select>
                        <span>裸号估值</span>
                        <select
                          aria-label={`${node.id}估值调整`}
                          value={node.price.adjustment}
                          onChange={(event) =>
                            update(node.id, {
                              price: {
                                ...node.price!,
                                value: 0,
                                adjustment: event.target.value as PriceCondition["adjustment"],
                              },
                            })
                          }
                        >
                          <option value="none">原值</option>
                          <option value="minus">减去</option>
                          <option value="plus">加上</option>
                        </select>
                        {node.price.adjustment !== "none" && (
                          <>
                            <input
                              aria-label={`${node.id}调整数值`}
                              type="number"
                              min="0"
                              step="0.01"
                              max={
                                node.price.unit === "percent" && node.price.adjustment === "minus"
                                  ? 100
                                  : 1e9
                              }
                              value={Number.isNaN(node.price.value) ? "" : node.price.value}
                              onChange={(event) =>
                                update(node.id, {
                                  price: {
                                    ...node.price!,
                                    value:
                                      event.target.value === "" ? NaN : Number(event.target.value),
                                  },
                                })
                              }
                            />
                            <select
                              aria-label={`${node.id}调整单位`}
                              value={node.price.unit}
                              onChange={(event) =>
                                update(node.id, {
                                  price: {
                                    ...node.price!,
                                    unit: event.target.value as PriceCondition["unit"],
                                  },
                                })
                              }
                            >
                              <option value="amount">元</option>
                              <option value="percent">%（裸号估值的百分比）</option>
                            </select>
                          </>
                        )}
                        <p className="analysis-condition-summary">
                          {priceConditionLabel(node.price)}
                        </p>
                      </div>
                    ) : (
                      <div>
                        <label>
                          {node.id} 条件
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
                        <div
                          className={`analysis-rule-preview is-${node.rule?.status || "pending"}`}
                          aria-label={`${node.id}执行口径`}
                        >
                          {node.rule &&
                          node.rule.sourceText === node.text.trim() &&
                          node.rule.version === RULE_ENGINE_VERSION ? (
                            <>
                              <strong>{ruleStatusLabels[node.rule.status]}</strong>
                              <p>{node.rule.explanation}</p>
                              {node.rule.issues.length > 0 && (
                                <ul>
                                  {node.rule.issues.map((issue, issueIndex) => (
                                    <li key={issueIndex}>{issue}</li>
                                  ))}
                                </ul>
                              )}
                              {node.rule.status !== "ready" && (
                                <p>
                                  本条将显示“无法判断”。请补充口径或改用可核实的条件后重新解析。
                                </p>
                              )}
                            </>
                          ) : (
                            <p>尚未解析当前文字，不能自动判为满足。</p>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
          <div className="analysis-condition-actions">
            {current.children.some((node) => !("children" in node) && !node.price) && (
              <button
                className="analysis-button analysis-button-primary"
                type="button"
                disabled={compiling}
                onClick={() => void compile()}
              >
                {compiling ? "正在解析条件…" : "解析文字条件"}
              </button>
            )}
            <button
              className="analysis-button analysis-button-outline"
              type="button"
              disabled={current.children.length >= 59}
              onClick={() => add()}
            >
              增加文字条件
            </button>
            <button
              className="analysis-button analysis-button-outline"
              type="button"
              disabled={current.children.length >= 59}
              onClick={() => add(true)}
            >
              增加价格条件
            </button>
            {value && (
              <button type="button" onClick={() => onChange(undefined)}>
                恢复默认入榜条件
              </button>
            )}
          </div>
          {compileNotice && (
            <p role="status" className="analysis-pending-note">
              {compileNotice}
            </p>
          )}
          {compileError && (
            <p role="alert" className="analysis-pending-note">
              {compileError}。原输入已保留。
            </p>
          )}
        </>
      )}
    </section>
  );
}

const labels = { met: "满足", unmet: "不满足", unknown: "无法判断" };
export function ConditionReviewView({ review }: { review?: ConditionReview }) {
  if (!review)
    return (
      <section>
        <h3>条件匹配</h3>
        <p>本次未配置条件</p>
      </section>
    );
  const results = new Map(review.results.map((result) => [result.id, result]));
  function render(node: ConditionNode) {
    const result = results.get(node.id);
    const title = `${node.id} ${"children" in node ? (node.evaluation === "sequence" ? "入榜条件（从上到下计算）" : node.operator === "and" ? "全部满足（且）" : "任意满足（或）") : node.price ? priceConditionLabel(node.price) : node.text}`;
    const description = (
      <>
        <strong>
          {title}：{result ? labels[result.status] : "无法判断"}
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
          {title}：{result ? labels[result.status] : "无法判断"}
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
            {render(child)}
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
      {review.engineVersion !== RULE_ENGINE_VERSION && (
        <p role="status" className="analysis-pending-note">
          历史条件记录，不作为当前入榜依据；当前榜单使用已解析规则重新计算。
        </p>
      )}
      {render(review.tree)}
    </section>
  );
}
