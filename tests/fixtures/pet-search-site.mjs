// SIMULATED official component contracts, not real-market evidence.
// Public pet.js field names and the shared detail panel are reproduced without identity/Cookie.
import { equipmentSearchDocument, roleSentinelDocument } from "./equipment-search-site.mjs";
export { roleSentinelDocument };
export const petFields = [
  ["类型", "画魂"],
  ["等级", "119"],
  ["成长", "1.28"],
  ["攻击资质", "1550 +22"],
  ["防御资质", "1400"],
  ["体力资质", "5000"],
  ["法力资质", "2800"],
  ["速度资质", "1200"],
  ["躲闪资质", "1100"],
].map(([name, value]) => ({ name, value }));
export const petSkills = ["须弥真言", "高级法术暴击"];
export const petGear = [{ name: "宝宝项圈", description: "等级：80\n速度：20" }];
const escape = (value) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
const encoded = (value) => JSON.stringify(value).replaceAll("<", "\\u003c");
export function petSearchDocument(options = {}) {
  const base = equipmentSearchDocument({
    pages: [[{ eid: "primary", name: "宝宝昵称", type: "2001" }]],
    ...options,
  })
    // The equipment fixture owns these widgets; pets have their own official public form.
    .replace(/\/\* EQUIPMENT_UI_START \*\/[\s\S]*?\/\* EQUIPMENT_UI_END \*\//, "")
    .replace("官方装备搜索结构模拟页", "官方宝宝搜索结构模拟页")
    .replace(
      "onComplete(){document.querySelector('#loading_img').style.display='none';}",
      "onComplete(){if(!settings.keepLoading)document.querySelector('#loading_img').style.display='none';}",
    )
    .replace(
      /window\.OverallSearchAct=[^;]+;/,
      `window.OverallSearchAct='overall_search_pet';window.SaleablePetNameInfo=${encoded(options.petNames || { 2001: "画魂", 3001: "幽灵" })};window.PetSkills=${encoded(
        options.petSkillChoices || [
          [1, "须弥真言"],
          [2, "高级法术暴击"],
        ],
      )};window.HighNeidans=[[9,'催心浪']];window.LowNeidans=[];window.TexingTypes=${encoded(
        options.petTraitChoices || [
          [718, "灵刃"],
          [712, "顺势"],
        ],
      )};`,
    )
    .replace(
      "img.setAttribute('data_equip_name',row.name);",
      "img.setAttribute('data_equip_name',row.name);img.setAttribute('data_equip_type',row.type||'2001');",
    );
  const numberKeys = [
    "level_min",
    "level_max",
    "skill_num",
    "attack_aptitude",
    "defence_aptitude",
    "physical_aptitude",
    "magic_aptitude",
    "speed_aptitude_min",
    "speed_aptitude_max",
    "lingxing",
  ];
  return (
    base +
    `<div id="fixture_pet_controls">
<input id="pet_select_box" type="text"><input id="txt_growth" type="text">
${(options.petStarChoices || [0, 1, 2, 3]).map((star) => `<label><input type="checkbox" value="${star}" class="js_super_sum_star">${["初始", "一星", "二星", "三星"][star]}</label>`).join("")}
${numberKeys.map((key) => `<label for="txt_${key}">${key}</label><input type="text" id="txt_${key}">`).join("")}
<label><input id="chk_is_baobao" type="checkbox">只显示宝宝</label>
<select id="overall_sel_area"><option value="">不限</option><option value="1" selected>旧地区</option></select>
<select id="ovarall_sel_server"><option value="">不限</option><option value="33" selected>旧服务器</option></select>
<input id="user_serverid" type="hidden" value="33"><input type="hidden" name="account-token" value="do-not-export">
<button id="btn_reset_user_server">重置购入服</button><button id="reset_all">重置</button><button id="btn_all_skill">全部技能</button>
<div id="pet_skill_wrap"><ul id="pet_skill_special_panel"></ul></div>
<ul id="server_type_panel"></ul><ul id="high_neidan_panel"></ul><ul id="low_neidan_panel"></ul><ul id="texing_panel"></ul>
<button id="btn_pet_search">全服搜索</button></div>
<script>
window.uiActions=[];
if(settings.publicLogin===0)window.IsLogin=0;
const root=document.getElementById('fixture_pet_controls');
const menu=(id,choices,skills=false)=>{for(const [value,label] of choices){const li=document.createElement('li');li.retrieve=(key)=>key==='value'?value:null;li.title=label;if(skills){li.setAttribute('data-skill_id',value);li.innerHTML='<img alt="'+label+'" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" width="24" height="24">';}else li.textContent=label;li.addEventListener('click',()=>{li.classList.toggle('on');uiActions.push({action:'choice',panel:id,value:String(value)});});document.getElementById(id).append(li);}};
menu('server_type_panel',[[1,'1年内服'],[2,'1到3年服'],[3,'3年以上服']]);
menu('pet_skill_special_panel',PetSkills,true);menu('high_neidan_panel',HighNeidans);menu('low_neidan_panel',LowNeidans);
menu('texing_panel',TexingTypes);
root.querySelectorAll('.js_super_sum_star').forEach(input=>input.addEventListener('change',()=>uiActions.push({action:'star-check',value:input.value,checked:input.checked})));
root.querySelectorAll('input:not([type=hidden])').forEach(input=>input.addEventListener('input',()=>uiActions.push({action:'input',id:input.id,value:input.value})));
document.getElementById('reset_all').onclick=()=>{root.querySelectorAll('li.on').forEach(li=>li.classList.remove('on'));root.querySelectorAll('input:not([type=hidden])').forEach(input=>{if(input.type!=='checkbox')input.value='';input.checked=false;});uiActions.push({action:'reset'});};
document.getElementById('btn_reset_user_server').onclick=()=>{if(!settings.stickyBuyServer)document.getElementById('user_serverid').value='';};
document.getElementById('btn_all_skill').onclick=()=>uiActions.push({action:'expand-skills'});
document.getElementById('btn_pet_search').onclick=()=>{
 const name=document.getElementById('pet_select_box').value;
 const args={type:Object.keys(SaleablePetNameInfo).filter(id=>SaleablePetNameInfo[id]===name).join(','),evol_skill_mode:0};
 for(const key of ${encoded(numberKeys)}){const value=document.getElementById('txt_'+key).value;if(value)args[key]=parseInt(value,10);}
 const growth=document.getElementById('txt_growth').value;if(growth)args.growth=parseInt(parseFloat(growth)*1000,10);
 for(const [key,id] of [['server_type','server_type_panel'],['skill','pet_skill_special_panel'],['high_neidan','high_neidan_panel'],['low_neidan','low_neidan_panel'],['texing','texing_panel']]){const values=Array.from(document.querySelectorAll('#'+id+' li.on')).map(li=>li.retrieve('value'));if(values.length)args[key]=values.join(',');}
 const starBoxes=Array.from(root.querySelectorAll('.js_super_sum_star'));const stars=starBoxes.filter(input=>input.checked).map(input=>parseInt(input.value,10));if(stars.length&&stars.length<starBoxes.length)args.super_sum_star=stars.join(',');
 if(document.getElementById('chk_is_baobao').checked)args.is_baobao=1;
 if(document.getElementById('ovarall_sel_server').value)args.serverid=document.getElementById('ovarall_sel_server').value;
 if(document.getElementById('user_serverid').value)args.cross_buy_serverid=document.getElementById('user_serverid').value;
 Object.assign(args,settings.uiOverrides||{});uiActions.push({action:'search-click',args:JSON.parse(JSON.stringify(args))});go_overall_search(args);
};
</script>${options.discoveryExtra || ""}`
  );
}
export function petDetailDocument(options = {}) {
  const s = {
    price: 368.6,
    rawPrice: "368.60",
    nickname: "宝宝昵称",
    rawName: "宝宝昵称",
    rawEid: null,
    selling: 1,
    status: "上架中",
    fields: petFields,
    skills: petSkills,
    innerSkills: [{ name: "催心浪", level: "5" }],
    equipment: [],
    parsedGear: null,
    missingSkill: false,
    missingInner: false,
    missingGear: false,
    lazyGear: false,
    gearFlavor: "",
    brokenGearTooltip: false,
    partialInlineGear: false,
    classOnlyGearTooltip: false,
    incompleteJson: false,
    cifuDecoration: true,
    previewSkills: [],
    recommendation: true,
    wrapperClass: "infoList goodsInfo",
    panelDelay: 0,
    infoDelay: 0,
    priceDelay: 0,
    jsonDelay: 0,
    recommendationFirst: false,
    recommendationMainIds: false,
    splitRegions: false,
    duplicatePanel: false,
    noPanelId: false,
    footerStatus: "",
    encodedJson: false,
    legacyDescription: false,
    missingPetParser: false,
    petParserFailure: false,
    panelLevel: "119",
    infoLevel: "119",
    bonusLineBreak: false,
    duplicateFields: [],
    missingDecoder: false,
    decoderFailure: false,
    malformedDecoded: false,
    ...options,
  };
  const pet = {
    type_id: 2001,
    pet_grade: "119",
    growth: s.rawGrowth ?? 1.28,
    attack_aptitude: 1550,
    attack_ext: 22,
    defence_aptitude: 1400,
    physical_aptitude: 5000,
    magic_aptitude: 2800,
    speed_aptitude: 1200,
    avoid_aptitude: 1100,
    all_skills: s.parsedSkillIds || [1, 2],
    neidan: s.innerSkills,
    equip_list: (s.parsedGear || s.equipment).map((gear) => ({
      name: gear.name,
      desc: gear.description,
      icon: `https://xyq.cbg.163.com/images/${gear.shipin ? "pet_shipin" : "equip"}/small/1.gif`,
    })),
    sp_skill_id: "0",
  };
  if (s.incompleteJson) delete pet.equip_list;
  if (s.missingPayloadField) delete pet[s.missingPayloadField];
  if (s.evolSkills !== undefined) pet.evol_skill_list = s.evolSkills;
  if (s.evolSkillMap !== undefined) pet.evol_skills = s.evolSkillMap;
  if (s.evolRaw !== undefined) pet.other = { EvolSkill: s.evolRaw };
  const gameConfig = {
    pet_info: { 2001: "画魂" },
    pet_skill_desc: { 1: { name: "须弥真言" }, 2: { name: "高级法术暴击" }, ...s.skillDirectory },
    pet_skill_high_to_other_level_mapping: s.evolMappings || {},
  };
  const legacyParts = Array.from({ length: 35 }, () => "0");
  legacyParts[0] = s.nickname;
  legacyParts[1] = "2001";
  legacyParts[2] = "119";
  legacyParts[20] = "1550";
  legacyParts[21] = "1400";
  legacyParts[22] = "5000";
  legacyParts[23] = "2800";
  legacyParts[24] = "1200";
  legacyParts[25] = "1100";
  legacyParts[26] = "1280";
  legacyParts[27] = "1|2";
  legacyParts[34] = '(["summon_core":([])])';
  const legacy = legacyParts.join(";");
  const description = s.legacyDescription ? legacy : JSON.stringify(pet);
  const rows = s.fields.filter(({ name }) => name !== "类型" && name !== "等级");
  const valueMarkup = (value) =>
    s.bonusLineBreak
      ? escape(value).replace(/ \+(\d+)/, '<span style="display:block">+$1</span>')
      : escape(value);
  const tableRows = [...rows, ...s.duplicateFields];
  const table = tableRows
    .map((field, index) =>
      index % 2 === 0
        ? `<tr><th>${field.name === "成长" ? "成　　长" : escape(field.name)}：</th><td>${valueMarkup(field.value)}</td>${tableRows[index + 1] ? `<th>${escape(tableRows[index + 1].name)}：</th><td>${valueMarkup(tableRows[index + 1].value)}</td>` : ""}</tr>`
        : "",
    )
    .join("");
  const skillImages = (s.missingSkill ? s.skills.slice(1) : s.skills)
    .map(
      (name, index) =>
        `<img width="40" height="40" src="https://xyq.cbg.163.com/images/skill/${index + 1}.gif" data_store_name="${escape(name)}">`,
    )
    .join("");
  const previewImages = s.previewSkills
    .map(
      (name) =>
        `<img width="40" height="40" src="https://xyq.cbg.163.com/images/skill/99.gif" data_equip_name="${escape(name)}" data_skill_type="cifu">`,
    )
    .join("");
  const innerImages = (s.missingInner ? [] : s.innerSkills)
    .map(
      ({ name, level }) =>
        `<img width="40" height="40" src="https://xyq.cbg.163.com/images/neidan/9.gif" data_equip_name="${escape(name)}" data_skill_type="neidan" data_equip_level="${escape(level)}">`,
    )
    .join("");
  const gearImages = (s.missingGear ? [] : s.equipment)
    .map((gear, index) => {
      const src = `https://xyq.cbg.163.com/images/${gear.shipin ? "pet_shipin" : "equip"}/small/1.gif`;
      if (!s.lazyGear)
        return `<img width="40" height="40" src="${src}" data_equip_name="${escape(gear.name)}" data_equip_desc="${escape(s.gearFlavor + gear.description)}">`;
      const text = `${gear.name}\n${s.brokenGearTooltip ? "未加载" : s.gearFlavor + gear.description}`;
      const tipId = `gear${index}${s.classOnlyGearTooltip ? "Tip" : "TipsBox"}`;
      const inline = s.partialInlineGear
        ? `data_equip_name="${escape(gear.name)}" data_equip_desc="等级：80"`
        : "";
      const linked = s.classOnlyGearTooltip ? "" : `data_tip_box="${tipId}"`;
      const tipKind = s.classOnlyGearTooltip ? 'class="equip_tips"' : 'role="tooltip"';
      return `<img width="40" height="40" src="${src}" ${inline} ${linked} onmouseenter="document.getElementById('${tipId}').style.display='block'" onmouseleave="document.getElementById('${tipId}').style.display='none'"><pre id="${tipId}" ${tipKind} style="display:none">${escape(text)}</pre>`;
    })
    .join("");
  const info = `<ul id="info_panel"><li>服务器：测试区 ID：${escape(s.nickname)} 等级：${escape(s.infoLevel)}</li><li>状态：${escape(s.status)}</li><li>价格：<span class="price">￥${s.price}（元）</span><span id="equip_price_addon_info">+ ￥999（元）(跨服交易费)</span></li></ul>`;
  const panel = `<div class="attribute"><div${s.noPanelId ? "" : ' id="equip_desc_panel"'}><p>名字：${escape(s.nickname)}${s.panelLevel === null ? "" : ` 等级：${escape(s.panelLevel)}`}</p><table>${table}</table><h4>赐福技能</h4>${previewImages}${s.cifuDecoration ? '<img width="40" height="40" src="https://xyq.cbg.163.com/images/skill/99.gif">' : ""}<h4>技能</h4>${skillImages}<h4>内丹</h4>${innerImages || "<p>无</p>"}<h4>宝宝装备</h4>${gearImages || "<p>无</p>"}</div></div>`;
  const main = s.splitRegions
    ? `<section>${info}</section><section>${panel}</section>`
    : `<div class="${escape(s.wrapperClass)}">${info}${panel}${s.duplicatePanel ? panel : ""}${s.footerStatus ? `<footer>${escape(s.footerStatus)}</footer>` : ""}</div>`;
  const recommendation = s.recommendation
    ? `<aside id="bottomRecommands" class="goodsInfo goodsRemmds recommandWrp">${s.recommendationMainIds ? '<ul id="info_panel"><li>状态：已下架</li><li class="price">￥10</li></ul><div id="equip_desc_panel">成长：9.99 攻击资质：9999</div>' : '<p>状态：已售出</p><span class="price">￥10</span><p>成长：9.99 攻击资质：9999</p>'}<img width="40" height="40" src="https://xyq.cbg.163.com/images/skill/99.gif" data_store_name="推荐技能"></aside>`
    : "";
  const visibleMain = s.panelDelay ? '<div id="delayed-main"></div>' : main;
  return `<meta charset="utf-8"><title>独立宝宝详情结构模拟页</title>
${s.recommendationFirst ? recommendation + visibleMain : visibleMain + recommendation}
<input type="hidden" id="equip_desc_value" value="${escape(s.encodedJson ? "@Sfixture@" : description)}">
<script>window.IsLogin=1;window.StorageStype={pet:2,role:3};window.equip={storage_type:2,equip_name:${encoded(s.rawName)},price:${encoded(s.rawPrice)},eid:${s.rawEid ? encoded(s.rawEid) : "new URL(location.href).searchParams.get('eid')"},server_id:1,is_selling:${encoded(s.selling)}};window.CBG_GAME_CONFIG=${encoded(gameConfig)};
${s.encodedJson && !s.missingDecoder ? `window.decodeCalls=0;window.decode_desc=value=>{window.decodeCalls++;if(value!=='@Sfixture@' || ${encoded(s.decoderFailure)})throw new Error('SIMULATED decode failure');return ${encoded(s.malformedDecoded ? "not JSON" : description)};};` : ""}
${s.legacyDescription && !s.missingPetParser ? `window.petParseCalls=0;window.get_pet_attrs_info=(value, options)=>{window.petParseCalls++;if(value!==${encoded(legacy)} || !options.only_basic_attr || ${encoded(s.petParserFailure)})throw new Error('SIMULATED legacy parser failure');return ${encoded(pet)};};` : ""}
${s.jsonDelay ? `const json=document.getElementById('equip_desc_value'), jsonValue=json.value;json.value='';setTimeout(()=>json.value=jsonValue,${s.jsonDelay});` : ""}
function delayParts(){
 ${s.infoDelay ? `const info=document.querySelector('#info_panel'), content=info.innerHTML;info.innerHTML='';setTimeout(()=>info.innerHTML=content,${s.infoDelay});` : ""}
 ${s.priceDelay ? `const price=document.querySelector('#info_panel .price'), value=price.innerHTML;price.innerHTML='';setTimeout(()=>price.innerHTML=value,${s.priceDelay});` : ""}
}
${s.panelDelay ? `setTimeout(()=>{document.getElementById('delayed-main').innerHTML=${encoded(main)};delayParts();},${s.panelDelay});` : "delayParts();"}
</script>`;
}
