import type { ConditionGroup, ConditionNode, ConditionReview } from "../server/analysis/conditions";

function nextId(root: ConditionGroup, prefix: string) {
  const ids = new Set<string>();
  function walk(node: ConditionNode) {
    ids.add(node.id);
    if ("children" in node) node.children.forEach(walk);
  }
  walk(root);
  let index = 1;
  while (ids.has(prefix + index)) index++;
  return prefix + index;
}

export function AnalysisConditions({
  value,
  onChange,
}: {
  value?: ConditionGroup;
  onChange: (value?: ConditionGroup) => void;
}) {
  function replace(id: string, replacement?: ConditionNode) {
    if (!value) return;
    function visit(node: ConditionNode): ConditionNode | undefined {
      if (node.id === id) return replacement;
      return "children" in node
        ? {
            ...node,
            children: node.children.flatMap((child) => {
              const next = visit(child);
              return next ? [next] : [];
            }),
          }
        : node;
    }
    onChange(visit(value) as ConditionGroup | undefined);
  }
  function render(group: ConditionGroup, depth: number) {
    return (
      <fieldset className="analysis-condition-group" key={group.id}>
        <legend>{group.id} 条件组</legend>
        <label>
          组合方式{" "}
          <select
            aria-label={`${group.id}组合方式`}
            value={group.operator}
            onChange={(event) =>
              replace(group.id, { ...group, operator: event.target.value as "and" | "or" })
            }
          >
            <option value="and">全部满足（且）</option>
            <option value="or">任意满足（或）</option>
          </select>
        </label>
        <button type="button" onClick={() => replace(group.id)}>
          删除{depth === 1 ? "全部条件" : "条件组"}
        </button>
        {group.children.map((node) =>
          "children" in node ? (
            render(node, depth + 1)
          ) : (
            <div className="analysis-condition-row" key={node.id}>
              <label>
                {node.id} 条件
                <textarea
                  aria-label={`${node.id}条件`}
                  maxLength={1000}
                  value={node.text}
                  onChange={(event) => replace(node.id, { ...node, text: event.target.value })}
                />
              </label>
              <button type="button" onClick={() => replace(node.id)}>
                删除{node.id}
              </button>
            </div>
          ),
        )}
        <button
          className="analysis-button analysis-button-outline"
          type="button"
          onClick={() =>
            replace(group.id, {
              ...group,
              children: [...group.children, { id: nextId(value!, "C"), text: "" }],
            })
          }
        >
          增加条件
        </button>
        {depth < 4 && (
          <button
            className="analysis-button analysis-button-outline"
            type="button"
            onClick={() =>
              replace(group.id, {
                ...group,
                children: [
                  ...group.children,
                  {
                    id: nextId(value!, "G"),
                    operator: "or",
                    children: [{ id: nextId(value!, "C"), text: "" }],
                  },
                ],
              })
            }
          >
            增加条件组
          </button>
        )}
      </fieldset>
    );
  }
  return (
    <section className="analysis-settings-section">
      <h3>补充分析条件</h3>
      <p>
        由AI逐条判断，不改变估值公式。缺少资料时显示“无法判断”，不会自动补采或查价。每组至少保留一条条件。
      </p>
      {value ? (
        render(value, 1)
      ) : (
        <button
          className="analysis-button analysis-button-outline"
          type="button"
          onClick={() =>
            onChange({ id: "G1", operator: "and", children: [{ id: "C1", text: "" }] })
          }
        >
          添加分析条件
        </button>
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
    const title = `${node.id} ${"children" in node ? (node.operator === "and" ? "全部满足（且）" : "任意满足（或）") : node.text}`;
    const description = (
      <>
        <strong>
          {title}：{result ? labels[result.status] : "无法判断"}
        </strong>
        <p>{result?.reason || "缺少判断结果"}</p>
      </>
    );
    return "children" in node ? (
      <details key={node.id} open className="analysis-condition-group">
        <summary>
          {title}：{result ? labels[result.status] : "无法判断"}
        </summary>
        <p>{result?.reason}</p>
        {node.children.map(render)}
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
      {render(review.tree)}
    </section>
  );
}
