// Local, public-product fixtures matching the observed official page component contracts.
// No login identity, Cookie, account token or real market response is used.
// The isolated regression routes intercept every simulated market request locally.
export const equipmentName = "测试腰带";
export const equipmentDescription =
  "等级：100\n防御：50\n特效：愤怒\n宝石：黑宝石\n锻炼等级：8\n耐久：300\n修理失败：0";
const pixel = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
const escape = (value) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

export function equipmentSearchDocument(options = {}) {
  const settings = {
    pages: [[{ eid: "primary", name: equipmentName }]],
    delay: 50,
    mode: "success",
    jewelry: false,
    ...options,
  };
  return `<meta charset="utf-8"><title>官方装备搜索结构模拟页</title>
<img id="loading_img" src="${pixel}" style="display:none">
<div id="search_empty_templ" style="display:none">没有符合条件的商品</div>
<div id="search_result"></div><div id="pager"></div><div class="searchForm" id="fixture_form"></div>
<script>
window.IsLogin=1;
window.EquipKinds=[[6,'剑'],[7,'双剑'],[18,'男衣'],[20,'腰带'],[19,'鞋子'],[21,'饰品']];
window.Kinds=[[61,'戒指'],[62,'耳饰'],[63,'手镯'],[64,'佩饰']];
window.SpecialEffects=[[3,'愤怒'],[5,'永不磨损']];
window.SpecialSkills=[[1036,'破血狂攻']];window.Gems=[[2,'太阳石'],[3,'舍利子'],[4,'光芒石'],[5,'月亮石'],[6,'黑宝石']];
window.settings=${JSON.stringify(settings).replaceAll("<", "\\u003c")};
if(!settings.suitConfigMissing){
window.SuitEffects=settings.jewelry?(settings.jewelrySuitEffects||['血气方刚','通真达灵','心无旁骛','健步如飞']):[[4013,'炼气化神'],[4005,'逆鳞']];
window.SuitAddedStatus={'炼气化神':4013,'逆鳞':4005};
window.SuitAppendSkills={'龙卷雨击':3018};
window.SuitTransformSkills={'噬天虎':1060};
window.SuitTransformCharms={'蛟龙':2035};
}
window.AUTO_SEARCH_CONFIG={wjd_equip_equip_type:settings.namedModels||{}};
window.CBG_GAME_CONFIG={minghun_attr:{102:'防御',106:'抗封印',101:'气血'}};
window.AddedAttr1=[[4,'法伤'],[3,'速度']];window.AddedAttr2=[[13,'防御'],[14,'法防'],[12,'气血']];
// This synthetic action deliberately differs from any assumed live API name.
window.OverallSearchAct=settings.yuanshen?'fixture_search_yuanshen':settings.jade?'yupo_search':settings.jewelry?'overall_search_lingshi':'overall_search_equip';
window.OverallSearchType=settings.yuanshen?'yuanshen':'equip';
window.CurSearchValue={arg:null,order_by:{key:null,sort:null}};
window.calls=[];window.historyWrites=0;
// These entry points preserve the onRequest/onSuccess/onComplete flow of the official script.
window.ajax_with_recommend=async function(options){
 options.onRequest();
 // Match the official helper after it rewrites the overall-search action.
 if(!settings.omitMarketRequest){
   const params={...options.data,act:'recommd_by_role',search_type:options.data.act,count:15,view_loc:'overall_search',...(settings.marketOverrides||{})};
   if(settings.marketPageOverride!==undefined)params.page=settings.marketPageOverride;
   await fetch('/cgi-bin/recommend.py?'+new URLSearchParams(params));
 }
 setTimeout(function(){
   if(settings.mode==='transport_failure'){ options.onFailure();options.onComplete();return; }
   if(settings.mode==='guard'){document.body.insertAdjacentHTML('beforeend','<div id="captcha_container">安全验证</div>');options.onComplete();return;}
   if(settings.mode==='stalled'){options.onComplete();return;}
   if(settings.mode==='error'){options.onSuccess({status:1,msg:'装备查询请求失败'});options.onComplete();return;}
   const page=options.data.page, activePages=settings.broadenedPages && options.data.init_hp<176 ? settings.broadenedPages : settings.pages;
   const rows=(activePages[page-1]||[]).filter(row=>['damage','all_wakan','init_damage_raw','init_wakan','init_defense','init_hp','init_dex'].every(key=>row.rawAttributes?.[key]===undefined || options.data[key]===undefined || row.rawAttributes[key]+(options.data.attr_with_melt?(row.meltAttributes?.[key]||0):0)>=options.data[key]));
   options.onSuccess({status:0,msg:rows,paging:{cur_page:page,num_begin:1,num_end:activePages.length}});
   options.onComplete();
 },settings.delay);
};
window.overall_search=function(args,page,order){
 const data={act:OverallSearchAct,page:page||1,...args};if(order.key)data.order_by=order.key+' '+order.sort;
 if(settings.dropServerType)delete data.server_type;
 calls.push(JSON.parse(JSON.stringify(data)));
 ajax_with_recommend({data,
  onRequest(){document.querySelector('#loading_img').style.display='';document.querySelector('#search_result').innerHTML='';document.querySelector('#pager').innerHTML='';},
  onFailure(){document.querySelector('#search_result').innerText='系统繁忙，请稍后再试';},
  onSuccess(result){
   if(result.status!==0)return;
   const root=document.querySelector('#search_result');
   if(!result.msg.length){root.innerHTML='<p>没有符合条件的商品</p>';return;}
   const table=document.createElement('table');
   for(const row of result.msg){const tr=document.createElement('tr'),td=document.createElement('td'),a=document.createElement('a'),img=document.createElement('img');a.className='soldImg';a.href='https://xyq.cbg.163.com/equip?s='+encodeURIComponent(row.serverId||'1')+'&eid='+encodeURIComponent(row.eid)+'&from_shareid=must-not-send-viewer&reco_request_id=tracking&cross_buy_serverid=99';img.src=${JSON.stringify(pixel)};img.width=40;img.height=40;img.setAttribute('data_equip_name',row.name);img.setAttribute('data_equipid','ordersn-'+row.eid);if(row.kindId!==undefined)img.setAttribute('data_kindid',row.kindId);if(row.modelId!==undefined)img.setAttribute('data_equip_type',row.modelId);if(row.level!==undefined)img.setAttribute('data_equip_level',row.level);a.append(img);td.append(a);if(row.description!==undefined){const desc=document.createElement('textarea');desc.id='equip_desc_'+(row.descriptionOrdersn||'ordersn-'+row.eid);desc.style.display='none';desc.value=row.description;td.append(desc);}tr.append(td);table.append(tr);}root.append(table);
   const pager=document.querySelector('#pager');
   if(result.paging.num_end>1){pager.append('第'+page+'页, 共'+result.paging.num_end+'页');const jump=document.createElement('input');jump.id='pager_input';jump.addEventListener('keydown',event=>{if(event.key==='Enter')goto(Number(jump.value));});pager.append(jump);if(page>1)pager.insertAdjacentHTML('beforeend','<a href="javascript:goto('+(page-1)+')">上一页</a>');if(page<result.paging.num_end)pager.insertAdjacentHTML('beforeend','<a href="javascript:goto('+(page+1)+')">下一页</a>');}
  },
  onComplete(){document.querySelector('#loading_img').style.display='none';}
 });
};
window.goto=function(page){overall_search(CurSearchValue.arg,page,CurSearchValue.order_by)};
window.go_overall_search=function(args){CurSearchValue.arg=args;overall_search(args,1,CurSearchValue.order_by);historyWrites++;};
/* EQUIPMENT_UI_START */
// Public widgets follow the saved official HTML/drag_slider.js contract. Their click handlers
// read the DOM, construct official fields and call the page's own component, like the live site.
const form=document.querySelector('#fixture_form');
const add=(html)=>form.insertAdjacentHTML('beforeend',html);
function field(id,kind='input',choices=[]){
 if(kind==='select')add('<select id="'+id+'"><option value="">不限</option>'+choices.map(([value,label])=>'<option value="'+value+'">'+label+'</option>').join('')+'</select>');
 else add('<input id="'+id+'" type="'+kind+'">');
}
function menu(id,choices){
 add('<ul class="btnList" id="'+id+'">'+choices.map(([,name])=>'<li><span>'+name+'</span></li>').join('')+'</ul>');
 const list=document.querySelectorAll('#'+id+' li');
 list.forEach((li,index)=>{li.retrieve=(key)=>key==='value'?choices[index][0]:undefined;li.addEventListener('click',()=>li.classList.toggle('on'));});
}
menu('server_type_panel',[[3,'3年以上服'],[2,'1到3年服'],[1,'1年内服']]);
menu('fair_show_panel',settings.jewelry||settings.jade?[[1,'已上架'],[0,'公示期']]:[['pass_fair_show','已上架'],['fair_show','公示期']]);
field('overall_sel_area','select',[['6','测试区']]);field('ovarall_sel_server','select',[['33','测试服']]);
field('user_serverid','hidden');document.querySelector('#user_serverid').value='99';
add('<button id="btn_reset_user_server">重置购入服</button><button id="reset_all">重置</button>');
window.uiEvents=[];
form.addEventListener('input',event=>uiEvents.push({type:'input',id:event.target.id,value:event.target.value}));
form.addEventListener('change',event=>uiEvents.push({type:'change',id:event.target.id,value:event.target.value}));
form.addEventListener('click',event=>uiEvents.push({type:'click',id:event.target.id||event.target.closest('[id]')?.id}));
const selected=(id)=>Array.from(document.querySelectorAll('#'+id+' li.on')).map(li=>li.retrieve('value')).join(',');
function buildSlider(id,step,grid){
 add('<div class="levelSlider" id="'+id+'" style="position:relative;width:200px;height:45px;margin:24px"><div class="track" style="width:200px;height:4px"></div><div class="startPoint" style="position:absolute;top:0;left:-23px;width:46px;height:35px;background:#ddd"><div class="num">60级</div></div><div class="endPoint" style="position:absolute;top:0;left:177px;width:46px;height:35px;background:#bbb"><div class="num">160级</div></div></div>');
 const root=document.getElementById(id);root.slider={options:{range:[60,160],step,grid},value:{min:60,max:160}};
 for(const name of ['startPoint','endPoint']){
  const handle=root.querySelector('.'+name);let drag=null;
  handle.addEventListener('mousedown',event=>{drag={mouse:event.pageX,value:root.slider.value[name==='startPoint'?'min':'max']};event.preventDefault();});
  document.addEventListener('mousemove',event=>{if(!drag)return;const value=Math.max(name==='startPoint'?60:root.slider.value.min,Math.min(name==='startPoint'?root.slider.value.max:160,drag.value+Math.round((event.pageX-drag.mouse)/grid)*step));root.slider.value[name==='startPoint'?'min':'max']=value;handle.style.left=((value-60)/step*grid-23)+'px';handle.style.zIndex='10';root.querySelector('.'+(name==='startPoint'?'endPoint':'startPoint')).style.zIndex='1';handle.querySelector('.num').innerText=value+'级';});
  document.addEventListener('mouseup',()=>{drag=null;});
 }
 root.reset=()=>{root.slider.value={min:60,max:160};for(const [name,value] of [['startPoint',60],['endPoint',160]]){const el=root.querySelector('.'+name);el.querySelector('.num').innerText=value+'级';el.style.left=((value-60)/step*grid-23)+'px';}};
}
if(settings.yuanshen){
 menu('equip_type_check_panel',[[93,'巨剑'],[17,'剑']]);menu('equip_attr_check_panel',[[51,'力量'],[62,'魔力']]);
 field('attr_type','select',[['shanghai','伤害'],['mingzhong','命中'],['fangyu','防御']]);
 for(const key of ['attr_value','addon_skill_chance','addon_effect_chance'])field('txt_'+key,'text');
}else if(settings.jade){
 menu('yupo_type_panel',[[61718,'上古玉魄·阳'],[61717,'上古玉魄·阴']]);menu('special_teji',Object.entries(CBG_GAME_CONFIG.minghun_teji||{}));menu('special_daoju',Object.entries(CBG_GAME_CONFIG.minghun_daoju||{}));
 for(const key of ['init_attrs','base_attrs1','base_attrs2','total_attrs','minghun_effect']){field('sel_'+key,'select',Object.entries(key==='minghun_effect'?CBG_GAME_CONFIG.minghun_effect||{}:CBG_GAME_CONFIG.minghun_attr));field('txt_'+key,'text');}
 field('txt_minghun_level_min','text');field('chk_include_ext_mh_lv','checkbox');
}else if(settings.jewelry){
 buildSlider('equip_level_slider',20,40);menu('kind_panel',Kinds);menu('added_attr_num_panel',[[2,'2条'],[3,'3条']]);
 const attrs=Array.from({length:19},(_,i)=>[i+1,'属性'+(i+1)]);
 field('sel_basic_attr_type','select',['damage','defense','magic_damage','magic_defense','fengyin','anti_fengyin','speed'].map(key=>[key,key]));
 field('txt_basic_attr_value','text');field('txt_jinglian_level','text');field('txt_repair_fail','text');field('txt_suit_effect_level','text');field('sel_suit_effect','select',(window.SuitEffects||[]).map((name,index)=>[index+1,name]));field('chk_has_eazy_effect','checkbox');
 add('<input type="radio" id="added_attr_logic_detail" name="added_attr_logic" value="detail">');
 for(let i=1;i<=3;i++)field('sel_add_attr'+i,'select',attrs);
}else{
 buildSlider('level_slider',10,20);menu('kind_check_panel',EquipKinds);menu('special_effect_panel',SpecialEffects);menu('special_skill_panel',SpecialSkills);menu('gem_panel',Gems);
 for(const key of ['repair_fail','damage','all_wakan','gem_level','init_defense','init_damage_raw','init_wakan','init_hp','init_dex','hole_num'])field('txt_'+key,'text');
 field('chk_attr_with_melt','checkbox');
 add('<div id="check_mode_panel"><input type="radio" name="special_mode" value="and" checked><input type="radio" name="special_mode" value="or"></div>');
 field('radio_short_cut','radio');field('sel_short_cut','select',window.SuitEffects||[]);
 for(const type of ['added_status','append_skill','transform_skill','transform_charm']){field('radio_'+type,'radio');field('txt_'+type,'text');}
}
const searchButton=settings.yuanshen?'btn_yuanshen_search':settings.jade?'btn_yupo_search':settings.jewelry?'btn_lingshi_search':'btn_equip_search';
add('<button id="'+searchButton+'">全服搜索</button>');
document.querySelector('#btn_reset_user_server').addEventListener('click',()=>document.querySelector('#user_serverid').value='');
document.querySelector('#reset_all').addEventListener('click',()=>{
 form.querySelectorAll('input:not([type=hidden]),select').forEach(el=>{if(el.type==='checkbox'||el.type==='radio')el.checked=false;else el.value='';});
 form.querySelectorAll('li.on').forEach(el=>el.classList.remove('on'));
 form.querySelectorAll('.levelSlider').forEach(el=>el.reset());
 const melt=document.querySelector('#chk_attr_with_melt');if(melt)melt.checked=true;
 const mode=document.querySelector('#check_mode_panel input[value=and]');if(mode)mode.checked=true;
});
document.querySelector('#'+searchButton).addEventListener('click',()=>{
 const arg={};
 for(const [key,id] of [['server_type','server_type_panel'],[settings.jewelry||settings.jade?'pass_fair_show':'front_status','fair_show_panel'],['kindid',settings.jewelry?'kind_panel':'kind_check_panel'],['equip_type','yupo_type_panel'],['special_effect','special_effect_panel'],['special_skill','special_skill_panel'],['gem_value','gem_panel'],['added_attr_num','added_attr_num_panel'],['special_teji','special_teji'],['special_daoju','special_daoju']]){const value=selected(id);if(value)arg[key]=value;}
 for(const el of form.querySelectorAll('input[type=text][id^=txt_]')){const key=el.id.slice(4);if(!el.value||key==='basic_attr_value'||['init_attrs','base_attrs1','base_attrs2','total_attrs','minghun_effect','added_status','append_skill','transform_skill','transform_charm'].includes(key))continue;arg[key]=Number(el.value);}
 if(settings.yuanshen){arg.fixture_kind=selected('equip_type_check_panel');arg.fixture_addon=selected('equip_attr_check_panel');arg.fixture_attr_type=document.querySelector('#attr_type').value;}
 else if(settings.jade){if(document.querySelector('#chk_include_ext_mh_lv').checked)arg.include_ext_mh_lv=1;for(const key of ['init_attrs','base_attrs1','base_attrs2','total_attrs','minghun_effect']){const value=document.querySelector('#sel_'+key).value;if(value)arg[key]=JSON.stringify({[value]:key==='minghun_effect'?Number(document.querySelector('#txt_'+key).value)*10:document.querySelector('#txt_'+key).value});}}
 else{const slider=document.querySelector('.levelSlider').slider.value;arg[settings.jewelry?'equip_level_min':'level_min']=slider.min;arg[settings.jewelry?'equip_level_max':'level_max']=slider.max;
 if(settings.jewelry){if(document.querySelector('#chk_has_eazy_effect').checked)arg.special_effect=1;const primary=document.querySelector('#sel_basic_attr_type').value;if(primary)arg[primary]=Number(document.querySelector('#txt_basic_attr_value').value);const suit=document.querySelector('#sel_suit_effect').value;if(suit)arg.suit_effect=suit;for(let i=1;i<=3;i++){const value=document.querySelector('#sel_add_attr'+i).value;if(value){arg.added_attr_logic='detail';arg['added_attr.'+value]=(arg['added_attr.'+value]||0)+1;}}}
 else{if(arg.special_effect)arg.special_mode=document.querySelector('#check_mode_panel input:checked')?.value||'and';if(document.querySelector('#chk_attr_with_melt').checked){if(['init_damage','init_damage_raw','all_damage','damage','init_defense','init_hp','init_dex','init_wakan','all_wakan'].some(key=>arg[key]))arg.attr_with_melt=1;}else{arg.attr_without_melt=1;arg.sum_attr_without_melt=1;}
 const shortcut=document.querySelector('#sel_short_cut').value;if(document.querySelector('#radio_short_cut').checked&&shortcut)arg.suit_effect=shortcut;
 for(const [type,values] of [['added_status',window.SuitAddedStatus],['append_skill',window.SuitAppendSkills],['transform_skill',window.SuitTransformSkills],['transform_charm',window.SuitTransformCharms]]){if(document.querySelector('#radio_'+type).checked){const name=document.querySelector('#txt_'+type).value;if(values?.[name])arg.suit_effect=String(values[name]);}}
 }}
 const server=document.querySelector('#ovarall_sel_server').value;if(server)arg.serverid=server;
 const buy=document.querySelector('#user_serverid').value;if(buy)arg.cross_buy_serverid=buy;
 if(settings.dropUiField)delete arg[settings.dropUiField];
 if(settings.extraUiFilters)Object.assign(arg,settings.extraUiFilters);
 window.go_overall_search(arg);
});

if(settings.omitControl)document.getElementById(settings.omitControl)?.remove();
/* EQUIPMENT_UI_END */
</script>`;
}

export function equipmentDetailDocument(options = {}) {
  const settings = {
    name: equipmentName,
    description: equipmentDescription,
    price: 1000,
    status: "已上架",
    recommend: false,
    recommendFirst: false,
    recommendSameName: false,
    tooltipDelay: 0,
    tooltipMissing: false,
    linkedTooltip: true,
    rawPrice: true,
    visiblePrice: true,
    rawName: null,
    rawEid: null,
    onlyRecommendation: false,
    renderedPanel: false,
    rawPriceValue: null,
    selling: null,
    modelName: null,
    modelDescription: null,
    modelId: null,
    kindId: null,
    independentPanels: false,
    missingInfoPanel: false,
    unsupportedContainer: false,
    panelDelay: 0,
    infoDelay: 0,
    ...options,
  };
  const icon = (name, tipId, recommended = false) =>
    `<img id="${recommended ? "recommended-icon" : "main-icon"}" width="50" height="50" src="${pixel}" data_equip_name="${escape(name)}" ${settings.linkedTooltip || recommended ? `data_tip_box="${tipId}"` : ""} ${recommended ? 'data_price="100"' : settings.visiblePrice ? `data_price="${settings.price}"` : ""} onmouseover="showTip('${tipId}')">`;
  // The live official template renders attributes directly, without a data_equip_name image.
  const main = settings.renderedPanel
    ? `<div class="${settings.unsupportedContainer ? "unsupported-product" : settings.independentPanels ? "independent-product" : "infoList goodsInfo"}"><ul ${settings.missingInfoPanel ? 'class="product-info"' : 'id="info_panel"'}><li>服务器：测试区 ${settings.missingInfoPanel ? "名称" : "ID"}：${escape(settings.name)} 等级：100</li><li>状态：${escape(settings.status)}</li><li>价格：${settings.visiblePrice ? `<span class="price fB">￥${settings.price}（元）</span>` : ""}<span id="equip_price_addon_info">+ ￥999（元）(跨服交易费)</span></li></ul><div class="attribute"><p id="equip_desc_panel" style="white-space:pre-line">${escape(settings.description)}</p></div></div>`
    : `<main id="equip_detail">${icon(settings.name, "EquipTipsBox")}${settings.visiblePrice ? `<span class="price">¥${settings.price}</span>` : ""}<p>是否上架：${escape(settings.status)}</p></main>`;
  const recommendedName = settings.recommendSameName ? settings.name : "推荐腰带";
  const recommend = settings.recommend
    ? `<aside ${settings.renderedPanel ? 'id="bottomRecommands" class="recommandWrp goodsInfo goodsRemmds"' : 'id="recommend"'}><h2>推荐商品</h2>${icon(recommendedName, "RecommendedTipsBox", true)}<span class="price">¥100</span><p>是否上架：已上架</p></aside>`
    : "";
  const tooltip = settings.tooltipMissing
    ? ""
    : `<div id="EquipTipsBox" role="tooltip" style="display:none;white-space:pre-line">${escape(settings.name + "\n" + settings.description)}</div>`;
  return `<meta charset="utf-8"><title>装备详情结构模拟页</title>
${settings.onlyRecommendation ? recommend : settings.panelDelay ? '<div id="delayed-main"></div>' + recommend : settings.recommendFirst ? recommend + main : main + recommend}${tooltip}
<div id="RecommendedTipsBox" role="tooltip" style="display:none;white-space:pre-line">${escape(recommendedName + "\n" + settings.description.replace("防御：50", "防御：99"))}</div>
<script>
window.IsLogin=1;window.hovers=[];window.tooltipDelay=${settings.tooltipDelay};
${settings.rawPrice ? `window.equip={price:${JSON.stringify(settings.rawPriceValue ?? settings.price)},equip_name:${JSON.stringify(settings.rawName || settings.name)},eid:${settings.rawEid ? JSON.stringify(settings.rawEid) : "new URL(location.href).searchParams.get('eid')"},server_id:1${settings.kindId !== null ? ",kindid:" + JSON.stringify(settings.kindId) : ""}${settings.selling !== null ? `,is_selling:${JSON.stringify(settings.selling)}` : ""}${settings.modelId !== null ? ",equip_type:" + JSON.stringify(settings.modelId) : settings.modelDescription !== null ? ",equip_type:2912" : ""}};` : ""}
${settings.modelDescription !== null ? `window.CBG_GAME_CONFIG={equip_info:{2912:{name:${JSON.stringify(settings.modelName || settings.name)},desc:${JSON.stringify(settings.modelDescription)}},9999:{name:"其他装备",desc:"【装备角色】男"}}};` : ""}
${settings.panelDelay ? "setTimeout(()=>document.getElementById('delayed-main').innerHTML=" + JSON.stringify(main).replaceAll("<", "\\u003c") + "," + settings.panelDelay + ");" : ""}
${settings.infoDelay ? "const info=document.getElementById('info_panel'),content=info.innerHTML;info.innerHTML='';setTimeout(()=>info.innerHTML=content," + settings.infoDelay + ");" : ""}
window.showTip=function(id){hovers.push(id);setTimeout(()=>{const tip=document.getElementById(id);if(tip)tip.style.display='block';},tooltipDelay);};
</script>`;
}

export const roleSentinelDocument = `<meta charset="utf-8"><title>原角色列表</title>
<p>原角色列表，第7页</p><script>window.QueryArgs={server_type:'3',page:7,order_by:'selling_time DESC'};window.checkpoint={key:'367:kept-role',page:7};</script>`;
