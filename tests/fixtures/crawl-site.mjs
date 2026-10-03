export const primaryPetSkill = "高级必杀";

const pages = { 1: ["a", "b"], 2: ["b", "c"] };

export const listHtml = (number) =>
  `<table id="soldList"><tr id="order_menu"><th><a data_attr_name="expire_time" onclick="QueryArgs.order_by='expire_time DESC';goto(1)">出售剩余时间</a></th></tr>${pages[number].map((id) => `<tr><td><a class="soldImg" target="_blank" href="https://xyq.cbg.163.com/equip?s=367&eid=${id}&reco_request_id=tracking" onmouseover="this.setAttribute('mouse_over_begin','hovered'); window.hovered.push('${id}')"><img alt="${id}" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" width="50" height="50" data_serverid="367" data_ordersn="order-${id}" data_equip_name="角色${id}" data_price="222" data_selling_time="2026-09-07 12:00:00"><textarea style="display:none">{"iExptSki1":20,"iBeastSki1":10}</textarea></a></td></tr>`).join("")}</table><div id="pager_bar">第${number}页, 共2页 <a href="javascript:goto(${number === 1 ? 2 : 1})">${number === 1 ? "下一页" : "上一页"}</a></div>`;

const raw = (id) => ({
  game_ordersn: `order-${id}`,
  expire_time: id === "a" ? 1900000030 : id === "b" ? 1900000020 : 1900000010,
});

export const listDocument = `<meta charset="utf-8"><script>var IsLogin=1;var LoginInfo={login:1};var QueryArgs={server_type:'3',page:1,order_by:'expire_time DESC'};var QueryResult=${JSON.stringify(pages[1].map(raw))};window.hovered=[];var records=${JSON.stringify({ 1: pages[1].map(raw), 2: pages[2].map(raw) })};function goto(n){document.querySelector('#LoadingCover').style.display='block';fetch('/mock-list?page='+n).then(r=>r.text()).then(text=>{document.querySelector('#query_result').innerHTML=text;QueryArgs.page=n;QueryResult=records[n];document.querySelector('#LoadingCover').style.display='none';});}</script><div id="LoadingCover" style="display:none">正在加载</div><div id="query_result">${listHtml(1)}</div>`;

const gear = (name, description) =>
  `<a data_equip_name="${name}" data_equip_desc="${description}" data_tip_box="RoleEquipTipsBox"><img width="30" height="30" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" onmouseover="window.gearHovers++;RoleEquipTipsBox.style.display='block';RoleEquipTipsBox.innerText=this.parentElement.getAttribute('data_equip_name')+' '+this.parentElement.getAttribute('data_equip_desc')"></a>`;

export const petBody = (n) =>
  `<p>详细信息</p><p>类型：测试宝宝${n + 1}\t等级：${100 + n}</p><p>成长：1.${280 + n}\t攻击资质：${1400 + n}</p><p>技能</p><img width="30" height="30" data_equip_name="${primaryPetSkill}" data_skill_type="cifu" data_equip_desc="技能的通用功效不要展示"><img width="30" height="30" data_equip_name="技能${n + 1}" data_skill_type="cifu" data_equip_desc="技能故事"><p>装备</p>${gear("宝宝项圈" + (n + 1), "等级：80#r速度：" + (20 + n))}<img width="30" height="30" data_equip_name="玄武躯" data_skill_type="neidan" data_equip_level="5" data_equip_desc="内丹的通用效果">`;

export const tabContent = {
  "人物/修炼":
    '<p>攻击修炼：20/20</p><p>攻击控制力：10</p><div role="tab" onclick="document.querySelector(\'#sub-detail\').innerText=\'法术抗性：999\'">输出/抗性</div><div id="sub-detail"></div>',
  技能: "<p>主技能：150</p><p>烹饪技巧：140</p>",
  "道具/法宝":
    "<p>道具和法宝</p>" +
    gear("测试刀", "等级：160#r伤害：500#r特技：罗汉金钟") +
    gear("测试头盔", "等级：150#r防御：90#r宝石：12"),
  "召唤兽/孩子":
    "<p>召唤兽(8/10)</p>" +
    Array.from(
      { length: 8 },
      (_, n) =>
        `<img width="50" height="50" data_idx="${n}" src="/images/pets/small/${n}.gif" onclick="selectPet(${n})">`,
    ).join("") +
    '<section id="petData">' +
    petBody(0) +
    "</section>",
  坐骑: "<p>坐骑成长：2.3</p>",
  "锦衣/外观": "<p>锦衣：测试锦衣</p>",
  玩家之家: "<p>房屋：豪宅</p>",
};

export const detailDocument = (missing, mainTabs) =>
  `<meta charset="utf-8"><script>var IsLogin=1;var LoginInfo={login:1,urs:'private-login-should-not-be-collected'};var EquipInfo={eid:'a',name:'测试角色',raw_info:{AllEquip:[{name:'测试刀',damage:500}],AllSummon:[{name:'测试吸血鬼',skills:['${primaryPetSkill}'],equips:[{name:'项圈',speed:20}]}]}};window.decode_desc=value=>value;window.RoleInfoParser=class{constructor(){this.raw_info={AllRider:{},jinjie_rider_info:{isJinJie:0},all_skills:{201:140},i3FlyLv:0};this.result={shenqi:false,basic_info:{is_gold_id:false}}}};window.visited=[];window.gearHovers=0;function selectPet(n){fetch('/mock-pet?n='+n).then(r=>r.text()).then(text=>document.querySelector('#petData').innerHTML=text)}function tab(name){window.visited.push(name);document.querySelector('#panel').innerText='正在读取…';fetch('/mock-tab?name='+encodeURIComponent(name)).then(r=>r.text()).then(text=>document.querySelector('#panel').innerHTML=text);}</script><p>顶部账号：private-login-should-not-be-collected</p><section id="role-detail"><nav>${mainTabs
    .filter((name) => !missing || name !== "玩家之家")
    .map((name) => `<button onclick="tab('${name}')">${name}</button>`)
    .join(
      "",
    )}</nav><div id="panel"><p>攻击修炼：20/20</p><p>${"角色基本属性说明。".repeat(24)}</p></div><div id="RoleEquipTipsBox" class="soldDetail" style="display:none;position:fixed;left:0;top:0;z-index:99;background:white"></div><textarea id="equip_desc_value" style="display:none">${"encoded-source".repeat(5000)}</textarea></section>`;
