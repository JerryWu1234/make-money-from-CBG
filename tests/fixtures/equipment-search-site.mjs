// Local, public-product fixtures matching the observed official page component contracts.
// No login identity, Cookie, account token, market response or real search request is used.
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
<div id="search_result"></div><div id="pager"></div>
<script>
window.IsLogin=1;
window.EquipKinds=[[6,'剑'],[7,'双剑'],[20,'腰带'],[19,'鞋子'],[21,'饰品']];
window.Kinds=[[61,'戒指'],[62,'耳饰'],[63,'手镯'],[64,'佩饰']];
window.SpecialEffects=[[3,'愤怒'],[5,'永不磨损']];
window.SpecialSkills=[[1036,'破血狂攻']];window.Gems=[[6,'黑宝石']];
window.settings=${JSON.stringify(settings).replaceAll("<", "\\u003c")};
window.AUTO_SEARCH_CONFIG={wjd_equip_equip_type:settings.namedModels||{}};
window.CBG_GAME_CONFIG={minghun_attr:{102:'防御',106:'抗封印',101:'气血'}};
window.AddedAttr1=[[4,'法伤'],[3,'速度']];window.AddedAttr2=[[13,'防御'],[14,'法防'],[12,'气血']];
window.OverallSearchAct=settings.jade?'yupo_search':settings.jewelry?'overall_search_lingshi':'overall_search_equip';
window.CurSearchValue={arg:null,order_by:{key:null,sort:null}};
window.calls=[];window.historyWrites=0;
// These entry points preserve the onRequest/onSuccess/onComplete flow of the official script.
window.ajax_with_recommend=function(options){
 options.onRequest();
 setTimeout(function(){
   if(settings.mode==='transport_failure'){ options.onFailure();options.onComplete();return; }
   if(settings.mode==='guard'){document.body.insertAdjacentHTML('beforeend','<div id="captcha_container">安全验证</div>');options.onComplete();return;}
   if(settings.mode==='stalled'){options.onComplete();return;}
   if(settings.mode==='error'){options.onSuccess({status:1,msg:'装备查询请求失败'});options.onComplete();return;}
   const page=options.data.page, activePages=settings.broadenedPages && options.data.init_hp<176 ? settings.broadenedPages : settings.pages, rows=activePages[page-1]||[];
   options.onSuccess({status:0,msg:rows,paging:{cur_page:page,num_begin:1,num_end:activePages.length}});
   options.onComplete();
 },settings.delay);
};
window.overall_search=function(args,page,order){
 const data={act:OverallSearchAct,page:page||1,...args};if(order.key)data.order_by=order.key+' '+order.sort;
 calls.push(JSON.parse(JSON.stringify(data)));
 ajax_with_recommend({data,
  onRequest(){document.querySelector('#loading_img').style.display='';document.querySelector('#search_result').innerHTML='';document.querySelector('#pager').innerHTML='';},
  onFailure(){document.querySelector('#search_result').innerText='系统繁忙，请稍后再试';},
  onSuccess(result){
   if(result.status!==0)return;
   const root=document.querySelector('#search_result');
   if(!result.msg.length){root.innerHTML='<p>没有符合条件的商品</p>';return;}
   const table=document.createElement('table');
   for(const row of result.msg){const tr=document.createElement('tr'),td=document.createElement('td'),a=document.createElement('a'),img=document.createElement('img');a.className='soldImg';a.href='https://xyq.cbg.163.com/equip?s=1&eid='+encodeURIComponent(row.eid)+'&from_shareid=must-not-send-viewer&reco_request_id=tracking&cross_buy_serverid=99';img.src=${JSON.stringify(pixel)};img.width=40;img.height=40;img.setAttribute('data_equip_name',row.name);img.setAttribute('data_equipid','ordersn-'+row.eid);if(row.kindId!==undefined)img.setAttribute('data_kindid',row.kindId);if(row.modelId!==undefined)img.setAttribute('data_equip_type',row.modelId);if(row.level!==undefined)img.setAttribute('data_equip_level',row.level);a.append(img);td.append(a);if(row.description!==undefined){const desc=document.createElement('textarea');desc.id='equip_desc_'+(row.descriptionOrdersn||'ordersn-'+row.eid);desc.style.display='none';desc.value=row.description;td.append(desc);}tr.append(td);table.append(tr);}root.append(table);
   const pager=document.querySelector('#pager');
   if(result.paging.num_end>1){pager.append('第'+page+'页, 共'+result.paging.num_end+'页');if(page>1)pager.insertAdjacentHTML('beforeend','<a href="javascript:goto('+(page-1)+')">上一页</a>');if(page<result.paging.num_end)pager.insertAdjacentHTML('beforeend','<a href="javascript:goto('+(page+1)+')">下一页</a>');}
  },
  onComplete(){document.querySelector('#loading_img').style.display='none';}
 });
};
window.goto=function(page){overall_search(CurSearchValue.arg,page,CurSearchValue.order_by)};
window.go_overall_search=function(args){CurSearchValue.arg=args;overall_search(args,1,CurSearchValue.order_by);historyWrites++;};
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
    panelDelay: 0,
    infoDelay: 0,
    ...options,
  };
  const icon = (name, tipId, recommended = false) =>
    `<img id="${recommended ? "recommended-icon" : "main-icon"}" width="50" height="50" src="${pixel}" data_equip_name="${escape(name)}" ${settings.linkedTooltip || recommended ? `data_tip_box="${tipId}"` : ""} ${recommended ? 'data_price="100"' : settings.visiblePrice ? `data_price="${settings.price}"` : ""} onmouseover="showTip('${tipId}')">`;
  // The live official template renders attributes directly, without a data_equip_name image.
  const main = settings.renderedPanel
    ? `<div class="${settings.independentPanels ? "independent-product" : "infoList goodsInfo"}"><ul id="info_panel"><li>服务器：测试区 ID：${escape(settings.name)} 等级：100</li><li>状态：${escape(settings.status)}</li><li>价格：${settings.visiblePrice ? `<span class="price fB">￥${settings.price}（元）</span>` : ""}<span id="equip_price_addon_info">+ ￥999（元）(跨服交易费)</span></li></ul><div class="attribute"><p id="equip_desc_panel" style="white-space:pre-line">${escape(settings.description)}</p></div></div>`
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
