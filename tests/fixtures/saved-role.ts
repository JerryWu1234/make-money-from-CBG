export const petSkills = ["测试技能甲", "测试技能乙"] as const;

export const roleUrl = (key: string) => `https://xyq.cbg.163.com/equip?s=367&eid=item-${key}`;

export function roleRecord(key: string, ready: boolean) {
  return {
    listing: {
      key,
      eid: `item-${key}`,
      price: "222",
      url: roleUrl(key),
      name: `角色${key}`,
      serverId: "367",
      serverName: "测试服",
      sellingTime: "2026-09-08T14:06:30.000Z",
      highlights: ["人物总修100", "高资质召唤兽"],
      summary: {
        cName: "清风明月",
        iGrade: 175,
        xiulian: 100,
        pet_xiulian: 87,
        AchPointTotal: 3743,
      },
    },
    status: key === "a" && !ready ? "pending" : "complete",
    error: null,
    detail:
      key === "a" && !ready
        ? null
        : {
            captureVersion: 4,
            collectedAt: "2026-09-13T15:00:00.000Z",
            raw: { test: key },
            tabs: [
              "人物/修炼",
              "技能",
              "道具/法宝",
              "召唤兽/孩子",
              "坐骑",
              "锦衣/外观",
              "玩家之家",
            ].map((name) => ({
              name,
              text: `${key} 的 ${name} 数据\n攻击修炼：25/25`,
              fields: [],
              tables: [],
              elements: [],
              tooltips: [],
              petCount: name === "召唤兽/孩子" ? 8 : undefined,
              pets:
                name === "召唤兽/孩子"
                  ? Array.from({ length: 8 }, (_, index) => ({
                      index: index + 1,
                      name: `宝宝${index + 1}`,
                      fields: [
                        { name: "成长", value: "1.30" },
                        { name: "攻击资质", value: String(1400 + index) },
                      ],
                      skills: petSkills.map((skill, index) => ({
                        index,
                        name: skill,
                        kind: "skill",
                      })),
                      innerSkills: [{ index: 0, name: "玄武躯", kind: "innerSkill", level: "5" }],
                      equipment: [
                        {
                          index: 0,
                          name: `宝宝项圈${index + 1}`,
                          kind: "equipment",
                          description: `速度：${20 + index}`,
                        },
                      ],
                    }))
                  : undefined,
              items:
                name === "道具/法宝"
                  ? [
                      {
                        index: 0,
                        name: "测试刀",
                        description: "伤害：500\n特技：罗汉金钟",
                        kind: "equipment",
                      },
                      {
                        index: 1,
                        name: "测试头盔",
                        description: "防御：90",
                        attributes: { 等级: "150" },
                      },
                    ]
                  : [],
            })),
          },
  };
}

export function rolePage(
  page: number,
  ready: boolean,
  scope: "all" | "complete" | "tasks" = "all",
) {
  const keys = ["a", "b", ...Array.from({ length: 43 }, (_, i) => `k${i + 3}`)].filter(
    (key) =>
      scope === "all" || (scope === "complete") === (roleRecord(key, ready).status === "complete"),
  );
  const totalPages = Math.max(1, Math.ceil(keys.length / 20));
  page = Math.max(1, Math.min(page, totalPages));
  return {
    page,
    pageSize: 20,
    total: keys.length,
    totalPages,
    items: keys.slice((page - 1) * 20, page * 20).map((key) => ({
      key,
      name: `角色${key}`,
      price: "222",
      url: roleUrl(key),
      serverId: "367",
      serverName: "测试服",
      highlights: ["总修100", "高资质宝宝"],
      sellingTime: "2026-09-08T14:06:30.000Z",
      collectedAt: ready ? "2026-09-13T15:00:00.000Z" : null,
      lastSeenAt: "2026-09-13T14:59:00.000Z",
      status: roleRecord(key, ready).status,
      error: null,
    })),
  };
}

export function crawlStatus(running: boolean, ready: boolean) {
  return {
    running,
    phase: running ? "collecting" : "completed",
    message: "正在采集角色详情…",
    page: 1,
    totalPages: 100,
    saved: ready ? 1 : 0,
    skipped: 0,
    totalSaved: ready ? 1 : 0,
    current: "角色a",
    itemIndex: 1,
    itemsOnPage: 15,
    detailProgress: "正在读取标签 4/7：召唤兽/孩子",
    database: "test.sqlite",
    recent: ["a", "b"].map((key) => ({
      key,
      name: `角色${key}`,
      price: "222",
      status: roleRecord(key, ready).status,
    })),
  };
}

export const browserStatus = {
  connected: true,
  running: false,
  workflowStep: "completed",
  isLoggedIn: true,
  loginStatus: "logged_in",
  message: "角色列表已就绪",
};
