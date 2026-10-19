import { equipmentDetailDocument } from "./equipment-search-site.mjs";

// Public UI contracts observed on the official pet-equipment form. Every request is intercepted.
export function petGearSearchDocument(settings = {}) {
  const config = {
    level: 95,
    name: "测试护腕",
    pages: [["one", "two", "three"]],
    scopeOverrides: {},
    residualFilters: true,
    allowedAddonStatuses: ["高级反震", "高级神佑复生"],
    ...settings,
  };
  const menus = (id, choices) =>
    `<ul id="${id}">${choices.map(([value, label]) => `<li data_value="${value}"><span>${label}</span></li>`).join("")}</ul>`;
  const inputs = [
    "speed",
    "fangyu",
    "mofa",
    "shanghai",
    "hp",
    "hit_ratio",
    "xiang_qian_level",
    "addon_sum_min",
    "addon_minjie_reduce",
    "addon_status",
    "repair_failed_times",
    "price_min",
    "price_max",
  ];
  // Simulate a restored previous search, including enabled coverable-suit selection.
  const residualInputs = config.residualFilters
    ? {
        speed: "777",
        fangyu: "222",
        mofa: "333",
        shanghai: "66",
        hp: "444",
        hit_ratio: "55",
        addon_status: "高级反震",
        repair_failed_times: "3",
        price_min: "99",
        price_max: "999",
      }
    : {};
  const checked = config.residualFilters ? " checked" : "";
  const selected = config.residualFilters ? " selected" : "";
  return `<meta charset="utf-8"><title>模拟召唤兽装备官网界面</title>
<style>li{display:inline-block;cursor:pointer;padding:5px}li.on{background:#dde}.levelSlider{position:relative;width:300px;height:70px;margin:30px}.track{position:absolute;width:280px;height:3px;top:40px;background:#888}.startPoint,.endPoint{position:absolute;width:46px;height:60px;top:5px;cursor:move;background:#eee;user-select:none}.num{pointer-events:none}.endPoint{z-index:2}</style>
<table class="searcTb"><tr><th>装备等级：</th><td><div class="levelSlider" id="level_slider"><div class="track"></div><div class="startPoint"><div class="num">5级</div></div><div class="endPoint"><div class="num">145级</div></div></div></td></tr>
<tr><th>装备类型：</th><td>${menus("EquipPosBox", [
    [2, "项圈"],
    [1, "铠甲"],
    [3, "护腕"],
  ])}</td></tr>
<tr><th>装备属性：</th><td>${inputs.map((id) => `<input type="text" id="${id}" size="5" value="${residualInputs[id] || ""}">`).join("")}${menus(
    "xiangqian_stone_attr_panel",
    [
      [1, "伤害"],
      [2, "灵力"],
      [3, "速度"],
      [4, "躲避"],
      [5, "气血"],
      [6, "防御"],
    ],
  )}</td></tr>
<tr><th>附加属性：</th><td>${menus("addon_skill_box", [
    ["addon_fali", "法力"],
    ["addon_liliang", "力量"],
    ["addon_lingli", "灵力"],
    ["addon_minjie", "敏捷"],
    ["addon_naili", "耐力"],
    ["addon_tizhi", "体质"],
  ])}</td></tr>
<tr><th>其他条件：</th><td><input id="addon_sum_include_damage" type="checkbox"${checked}><input id="no_suit_effect" type="checkbox"${checked}><input id="has_suit_effect" type="checkbox"${checked}></td></tr>
<tr><th>开服时间：</th><td><ul id="server_type_panel"><li><span>3年以上服</span></li><li><span>1到3年服</span></li><li><span>1年内服</span></li></ul></td></tr>
<tr><th>指定区服：</th><td><select id="overall_sel_area"><option value="">--请选择--</option><option value="33"${selected}>测试区</option><option value="34">其他区</option></select><select id="ovarall_sel_server"><option value="">--请选择--</option><option value="1"${selected}>测试服</option></select></td></tr></table>
<input type="hidden" id="user_serverid" value="33"><a id="btn_reset_user_server">重置跨服</a><a id="reset_all">重置</a><a id="btn_do_query">全服搜索</a>
<img id="loading_img" style="display:none"><div id="query_result"></div><div id="pager_bar"></div>
<script>
window.settings=${JSON.stringify(config).replaceAll("<", "\\u003c")};window.IsLogin=settings.publicLogin??1;window.CaptchaCheck={need_captcha:false};window.calls=[];window.queryErrors=[];window.drags=0;
window.server_data=settings.serverDirectory||{'33':[['测试区',''],[[1,'测试服',0]]],'34':[['其他区',''],[[33,'其他服',0]]]};window.scopeActions=[];
const areaSelect=document.getElementById('overall_sel_area'),serverSelect=document.getElementById('ovarall_sel_server');
areaSelect.addEventListener('change',()=>{const rows=server_data[areaSelect.value]?.[1]||[];serverSelect.replaceChildren(new Option('--请选择--',''),...rows.map(([id,name])=>new Option(name,String(id))));document.querySelectorAll('#server_type_panel li.on').forEach(li=>li.classList.remove('on'));scopeActions.push({action:'area-change',area:areaSelect.value,servers:rows.map(([id])=>String(id))});});
serverSelect.addEventListener('change',()=>scopeActions.push({action:'server-change',server:serverSelect.value}));
const slider=document.getElementById('level_slider');slider.slider={options:{grid:20,step:10,range:[5,145]},setValue(){throw Error('Fixture forbids programmatic slider setter')}};
let range={min:5,max:145},drag=null;
function renderSlider(){for(const [cls,key] of [['startPoint','min'],['endPoint','max']]){const el=slider.querySelector('.'+cls);el.style.left=((range[key]-5)/10*20-23)+'px';el.querySelector('.num').textContent=range[key]+'级'}}
renderSlider();for(const [cls,key] of [['startPoint','min'],['endPoint','max']])slider.querySelector('.'+cls).addEventListener('mousedown',e=>{drag={key,x:e.clientX,value:range[key]};e.preventDefault()});
document.addEventListener('mousemove',e=>{if(!drag)return;let val=drag.value+Math.round((e.clientX-drag.x)/20)*10;val=Math.max(5,Math.min(145,val));if(drag.key==='min')val=Math.min(range.max,val);else val=Math.max(range.min,val);range[drag.key]=val;renderSlider()});document.addEventListener('mouseup',()=>{if(drag)drags++;drag=null});
for(const menu of document.querySelectorAll('ul[id]')){Array.from(menu.children).forEach((li,index)=>{if(menu.id==='server_type_panel'){const value=[3,2,1][index];li.retrieve=key=>key==='value'?value:null}li.addEventListener('click',()=>li.classList.toggle('on'))})}
function selected(id){return Array.from(document.querySelectorAll('#'+id+' > li.on')).map(li=>li.getAttribute('data_value')||li.retrieve?.('value')).join(',')}
document.getElementById('btn_reset_user_server').onclick=()=>document.getElementById('user_serverid').value='';
document.getElementById('reset_all').onclick=()=>{for(const li of document.querySelectorAll('ul[id] li'))li.classList.remove('on');for(const input of document.querySelectorAll('input[type=text]'))input.value='';areaSelect.value='';areaSelect.dispatchEvent(new Event('change'));range={min:5,max:145};renderSlider()};
function args(){const result={level_min:range.min,level_max:range.max};for(const input of document.querySelectorAll('input[type=text]'))if(input.value)result[input.id]=input.id==='addon_status'||input.id==='repair_failed_times'?input.value:Number(input.value)*(/^price_/.test(input.id)?100:1);for(const key of ['equip_pos','xiangqian_stone_attr','server_type']){const id={equip_pos:'EquipPosBox',xiangqian_stone_attr:'xiangqian_stone_attr_panel',server_type:'server_type_panel'}[key];if(selected(id))result[key]=selected(id)}for(const value of selected('addon_skill_box').split(',').filter(Boolean))result[value]=1;if(document.getElementById('addon_sum_include_damage').checked)result.addon_sum_include_damage=1;if(document.getElementById('no_suit_effect').checked)result.include_no_skill=1;const cover=document.getElementById('has_suit_effect');if(!cover.disabled&&cover.checked)result.include_can_cover_skill=1;if(document.getElementById('ovarall_sel_server').value)result.serverid=document.getElementById('ovarall_sel_server').value;if(document.getElementById('user_serverid').value)result.cross_buy_serverid=document.getElementById('user_serverid').value;Object.assign(result,settings.extraUiFilters||{});return result}
async function query(page){const fields=args();if(fields.addon_status&&!settings.allowedAddonStatuses.includes(fields.addon_status)){queryErrors.push('附加状态填写错误');return}window.QueryArgs={...fields,act:'overall_search_pet_equip',page};calls.push({...QueryArgs,drags});document.getElementById('loading_img').style.display='';document.getElementById('query_result').innerHTML='';const actual={...QueryArgs,act:'recommd_by_role',search_type:QueryArgs.act,...settings.scopeOverrides};if(settings.dropServerId||settings.dropServerPage===page)delete actual.serverid;await fetch('/cgi-bin/recommend.py?'+new URLSearchParams(actual));const ids=settings.pages[page-1]||[];document.getElementById('query_result').innerHTML=ids.length?'<table id="soldList">'+ids.map(id=>'<tr><td><a class="soldImg" href="https://xyq.cbg.163.com/equip?s='+(settings.rowServerId||1)+'&eid='+id+'"><img data_equip_name="'+(settings.rowNames?.[id]||settings.name)+'" data_equip_level="'+(settings.rowLevels?.[id]||settings.level)+'" data_serverid="'+(settings.rowServerId||1)+'"></a></td></tr>').join('')+'</table>':'没有符合条件的商品';document.getElementById('pager_bar').innerHTML='第'+page+'页, 共'+settings.pages.length+'页'+(page<settings.pages.length?'<a id="next-page">下一页</a>':'');if(document.getElementById('next-page'))document.getElementById('next-page').onclick=()=>query(page+1);document.getElementById('loading_img').style.display='none'}
document.getElementById('btn_do_query').onclick=()=>query(1);
</script>`;
}

export function petGearDetailDocument(settings) {
  return equipmentDetailDocument({
    renderedPanel: true,
    kindId: 29,
    modelDescription: "【装备对象】召唤兽\n【装备条件】等级" + settings.level,
    selling: 1,
    ...settings,
  });
}
