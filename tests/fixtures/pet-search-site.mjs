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
  return equipmentSearchDocument({
    pages: [[{ eid: "primary", name: "宝宝昵称", type: "2001" }]],
    ...options,
  })
    .replace("官方装备搜索结构模拟页", "官方宝宝搜索结构模拟页")
    .replace(
      /window\.OverallSearchAct=[^;]+;/,
      "window.OverallSearchAct='overall_search_pet';window.SaleablePetNameInfo={'2001':'画魂','3001':'幽灵'};window.PetSkills=[[1,'须弥真言'],[2,'高级法术暴击']];window.HighNeidans=[[9,'催心浪']];window.LowNeidans=[];",
    )
    .replace(
      "img.setAttribute('data_equip_name',row.name);",
      "img.setAttribute('data_equip_name',row.name);img.setAttribute('data_equip_type',row.type||'2001');",
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
    incompleteJson: false,
    cifuDecoration: true,
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
    growth: 1.28,
    attack_aptitude: 1550,
    attack_ext: 22,
    defence_aptitude: 1400,
    physical_aptitude: 5000,
    magic_aptitude: 2800,
    speed_aptitude: 1200,
    avoid_aptitude: 1100,
    all_skills: [1, 2],
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
  const innerImages = (s.missingInner ? [] : s.innerSkills)
    .map(
      ({ name, level }) =>
        `<img width="40" height="40" src="https://xyq.cbg.163.com/images/neidan/9.gif" data_equip_name="${escape(name)}" data_skill_type="neidan" data_equip_level="${escape(level)}">`,
    )
    .join("");
  const gearImages = (s.missingGear ? [] : s.equipment)
    .map(
      (gear) =>
        `<img width="40" height="40" src="https://xyq.cbg.163.com/images/${gear.shipin ? "pet_shipin" : "equip"}/small/1.gif" data_equip_name="${escape(gear.name)}" data_equip_desc="${escape(gear.description)}">`,
    )
    .join("");
  const info = `<ul id="info_panel"><li>服务器：测试区 ID：${escape(s.nickname)} 等级：${escape(s.infoLevel)}</li><li>状态：${escape(s.status)}</li><li>价格：<span class="price">￥${s.price}（元）</span><span id="equip_price_addon_info">+ ￥999（元）(跨服交易费)</span></li></ul>`;
  const panel = `<div class="attribute"><div${s.noPanelId ? "" : ' id="equip_desc_panel"'}><p>名字：${escape(s.nickname)}${s.panelLevel === null ? "" : ` 等级：${escape(s.panelLevel)}`}</p><table>${table}</table><h4>赐福技能</h4>${s.cifuDecoration ? '<img width="40" height="40" src="https://xyq.cbg.163.com/images/skill/99.gif">' : ""}<h4>技能</h4>${skillImages}<h4>内丹</h4>${innerImages || "<p>无</p>"}<h4>宝宝装备</h4>${gearImages || "<p>无</p>"}</div></div>`;
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
<script>window.IsLogin=1;window.StorageStype={pet:2,role:3};window.equip={storage_type:2,equip_name:${encoded(s.rawName)},price:${encoded(s.rawPrice)},eid:${s.rawEid ? encoded(s.rawEid) : "new URL(location.href).searchParams.get('eid')"},server_id:1,is_selling:${encoded(s.selling)}};window.CBG_GAME_CONFIG={pet_info:{2001:'画魂'},pet_skill_desc:{1:{name:'须弥真言'},2:{name:'高级法术暴击'}}};
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
