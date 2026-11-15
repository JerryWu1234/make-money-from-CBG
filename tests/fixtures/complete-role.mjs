// Synthetic, offline source ledger. Every asset group is deliberately nonempty.
export const completeRole = {
  serverId: "367",
  eid: "coverage-role",
  name: "完整覆盖角色",
  level: "175",
  attackTraining: "25/25",
  schoolSkills: Array.from({ length: 7 }, (_, i) => ({
    id: String(100 + i),
    name: "覆盖师门" + ["甲", "乙", "丙", "丁", "戊", "己", "庚"][i],
    level: 150 + i,
    slot: i + 1,
  })),
  auxiliary: { name: "强身术", level: 120 },
  life: { name: "烹饪技巧", level: 140 },
  gear: [
    {
      name: "覆盖武器",
      category: "武器",
      model: "900001",
      location: "RoleUsingEquips",
      description: "等级：100#r伤害：420#r命中：500",
      existing: true,
    },
    {
      name: "仓库头盔",
      category: "头盔",
      model: "900002",
      location: "RoleStoreEquips",
      description: "等级：100#r防御：80#r魔法：120",
      existing: false,
    },
  ],
  pets: [0, 1].map((i) => ({
    name: "覆盖宝宝" + (i + 1),
    type: "幽灵",
    level: 100 + i,
    grow: "1.280",
    skills: ["高级必杀", "高级连击"],
    equipment: "覆盖项圈" + (i + 1),
    inner: "玄武躯",
  })),
  mounts: [
    { name: "覆盖坐骑甲", grow: 230 },
    { name: "覆盖坐骑乙", grow: 250 },
  ],
  clothes: "青花瓷",
  accessory: "浪淘沙",
  home: "豪宅",
  garden: "大型庭院",
  child: "覆盖孩子",
  cash: { iCash: 1000, iSaving: 2000, iLearnCash: 3000, xianyu: 400 },
};
const pixel = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
const esc = (s) =>
  String(s).replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
const row = (name, value) => `<table><tr><td>${name}：</td><td>${value}</td></tr></table>`;
const icon = (name, more = "") =>
  `<img width="22" height="22" src="${pixel}" data_equip_name="${esc(name)}" ${more}>`;
const gearIcon = (gear, demand) =>
  icon(
    gear.name,
    `data_equip_type="${gear.model}" data_equip_category="${gear.category}" ${gear.existing && !demand ? `data_equip_desc="${esc(gear.description)}"` : ""} data_tip_box="RoleEquipTipsBox" onmouseover="window.coverageHovers.push('${gear.name}');const tip=document.querySelector('#RoleEquipTipsBox');tip.innerText='${gear.name}\\n'+${JSON.stringify(gear.description.replaceAll("#r", "\n")).replaceAll('"', "&quot;")};tip.style.display='block'"`,
  );
export function completeRoleDocument({
  demand = false,
  missingRiders = false,
  missingPetSection = false,
} = {}) {
  const d = completeRole;
  const tabs = ["人物/修炼", "技能", "道具/法宝", "召唤兽/孩子", "坐骑", "锦衣/外观", "玩家之家"];
  const pet = (n) => {
    const p = d.pets[n];
    return `<p>详细信息</p>${row("名称", p.name)}${row("类型", p.type)}${row("等级", p.level)}${row("成长", p.grow)}${["攻击资质", "防御资质", "体力资质", "法力资质", "速度资质", "躲闪资质"].map((k) => row(k, 1400 + n)).join("")}<p>技能（2）</p>${p.skills.map((s) => icon(s, 'data_skill_type="cifu"')).join("")}<p>装备（1）</p>${icon(p.equipment, `data_equip_category="项圈" data_equip_desc="等级：80#r速度：20" data_tip_box="RoleEquipTipsBox" onmouseover="window.coverageHovers.push('${p.equipment}');const tip=document.querySelector('#RoleEquipTipsBox');tip.innerText='${p.equipment}\\n等级：80\\n速度：20';tip.style.display='block'"`)}${missingPetSection ? "" : `<p>内丹（1）</p>${icon(p.inner, 'data_skill_type="neidan" data_equip_level="5"')}`}`;
  };
  const panels = {
    "人物/修炼":
      row("名称", d.name) +
      row("等级", d.level) +
      row("攻击修炼", d.attackTraining) +
      row("气血", "5000"),
    技能:
      "<p>师门技能</p>" +
      d.schoolSkills
        .map(
          (s) =>
            `<div><p>${s.level}</p><p>${s.name}</p>${icon(s.name, `data_skill_type="school_skill" data_equip_level="${s.level}" onmouseover="window.coverageHovers.push('${s.name}')"`)}</div>`,
        )
        .join("") +
      "<p>生活技能</p>" +
      row(d.life.name, d.life.level) +
      icon(
        d.life.name,
        `data_skill_type="life_skill" data_equip_level="${d.life.level}" onmouseover="window.coverageHovers.push('${d.life.name}')"`,
      ) +
      "<p>辅助技能</p>" +
      row(d.auxiliary.name, d.auxiliary.level) +
      icon(
        d.auxiliary.name,
        `data_skill_type="assist_skill" data_equip_level="${d.auxiliary.level}" onmouseover="window.coverageHovers.push('${d.auxiliary.name}')"`,
      ),
    "道具/法宝":
      "<p>道具和法宝</p>" +
      d.gear.map((g) => `<div id="${g.location}">${gearIcon(g, demand)}</div>`).join(""),
    "召唤兽/孩子":
      "<p>召唤兽(2/10)</p>" +
      d.pets
        .map(
          (p, i) =>
            `<img width="25" height="25" src="/pets/small/${i}.gif" data_idx="${i}" alt="${p.name}" onclick="selectPet(${i})">`,
        )
        .join("") +
      `<section id="coverage-pet">${pet(0)}</section><p>孩子</p><ul class="child_list"><li data-child-id="child" onclick="this.className='selected';document.querySelector('#coverage-child').innerText='名称：${d.child}'">${d.child}</li></ul><p id="coverage-child"></p>`,
    坐骑:
      '<div id="RoleRiders">' +
      d.mounts
        .map(
          (m, i) =>
            `<img src="${pixel}" width="25" height="25" data_idx="${i}" alt="${m.name}" onclick="selectMount(${i})">`,
        )
        .join("") +
      '</div><p id="coverage-mount">名称：覆盖坐骑甲\n坐骑成长：2.3</p>',
    "锦衣/外观": row("锦衣", d.clothes) + row("祥瑞", d.accessory),
    玩家之家: row("房屋", d.home) + row("庭院", d.garden),
  };
  const raw = {
    ...d.cash,
    all_skills: {
      ...Object.fromEntries(d.schoolSkills.map((s) => [s.id, s.level])),
      200: 120,
      201: 140,
      230: 40,
      237: 20,
    },
    i3FlyLv: 0,
    jinjie_rider_info: { isJinJie: 0 },
    ...(missingRiders
      ? {}
      : {
          AllRider: Object.fromEntries(
            d.mounts.map((m, i) => [i, { iGrow: m.grow, exgrow: 0, mattrib: "力量" }]),
          ),
        }),
  };
  return `<meta charset="utf-8"><style>body{font:14px sans-serif}table{margin:3px}img{margin:2px}</style><script>
    window.IsLogin=1;window.EquipInfo={server_id:367,eid:'coverage-role'};window.coverageHovers=[];window.coverageVisits=[];window.coverageRaw=${JSON.stringify(raw)};window.decode_desc=x=>x;
    window.RoleInfoParser=class{constructor(text){this.raw_info=JSON.parse(text);this.conf={skill:{school_skill:${JSON.stringify(Object.fromEntries(d.schoolSkills.map((s) => [s.id, { name: s.name, pos: s.slot }])))}}};this.result={shenqi:false,basic_info:{is_gold_id:false}}}};
    window.panels=${JSON.stringify(panels)};window.petBodies=${JSON.stringify(d.pets.map((_, i) => pet(i)))};
    function show(name){window.coverageVisits.push(name);document.querySelectorAll('nav button').forEach(b=>b.setAttribute('aria-selected',String(b.textContent===name)));document.querySelector('#coverage-panel').innerHTML=panels[name]}
    function selectPet(i){document.querySelectorAll('img[src*="/pets/small/"]').forEach((n,j)=>n.className=j===i?'selected':'');document.querySelector('#coverage-pet').innerHTML=petBodies[i]}
    function selectMount(i){document.querySelectorAll('#RoleRiders img').forEach((n,j)=>n.className=j===i?'selected':'');document.querySelector('#coverage-mount').innerHTML='<table><tr><td>名称：</td><td>'+${JSON.stringify(d.mounts.map((m) => m.name))}[i]+'</td></tr></table><table><tr><td>坐骑成长：</td><td>'+${JSON.stringify(d.mounts.map((m) => m.grow / 100))}[i]+'</td></tr></table>'}
  </script><section id="coverage-detail"><header>价格：￥12345<p>${"商品详情仅供离线覆盖验证。".repeat(14)}</p></header><nav>${tabs.map((n, i) => `<button aria-selected="${i === 0}" onclick="show('${n}')">${n}</button>`).join("")}</nav><article id="coverage-panel">${panels[tabs[0]]}</article><div id="RoleEquipTipsBox" style="display:none"></div><textarea id="equip_desc_value" hidden>${esc(JSON.stringify(raw))}</textarea></section>`;
}
