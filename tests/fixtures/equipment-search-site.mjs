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
window.EquipKinds=[[6,'剑'],[7,'双剑'],[20,'腰带']];
window.Kinds=[[61,'戒指'],[62,'耳饰'],[63,'手镯'],[64,'佩饰']];
window.SpecialEffects=[[3,'愤怒'],[5,'永不磨损']];
window.SpecialSkills=[[1036,'破血狂攻']];window.Gems=[[6,'黑宝石']];
window.settings=${JSON.stringify(settings).replaceAll("<", "\\u003c")};
window.OverallSearchAct=settings.jewelry?'overall_search_lingshi':'overall_search_equip';
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
   const page=options.data.page, rows=settings.pages[page-1]||[];
   options.onSuccess({status:0,msg:rows,paging:{cur_page:page,num_begin:1,num_end:settings.pages.length}});
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
   for(const row of result.msg){const tr=document.createElement('tr'),td=document.createElement('td'),a=document.createElement('a'),img=document.createElement('img');a.className='soldImg';a.href='https://xyq.cbg.163.com/equip?s=1&eid='+encodeURIComponent(row.eid);img.src=${JSON.stringify(pixel)};img.width=40;img.height=40;img.setAttribute('data_equip_name',row.name);img.setAttribute('data_equipid','ordersn-'+row.eid);a.append(img);td.append(a);tr.append(td);table.append(tr);}root.append(table);
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
    ...options,
  };
  const icon = (name, tipId, recommended = false) =>
    `<img id="${recommended ? "recommended-icon" : "main-icon"}" width="50" height="50" src="${pixel}" data_equip_name="${escape(name)}" ${settings.linkedTooltip || recommended ? `data_tip_box="${tipId}"` : ""} ${recommended ? 'data_price="100"' : settings.visiblePrice ? `data_price="${settings.price}"` : ""} onmouseover="showTip('${tipId}')">`;
  const main = `<main id="equip_detail">${icon(settings.name, "EquipTipsBox")}${settings.visiblePrice ? `<span class="price">¥${settings.price}</span>` : ""}<p>是否上架：${escape(settings.status)}</p></main>`;
  const recommendedName = settings.recommendSameName ? settings.name : "推荐腰带";
  const recommend = settings.recommend
    ? `<aside id="recommend"><h2>推荐商品</h2>${icon(recommendedName, "RecommendedTipsBox", true)}<span class="price">¥100</span><p>是否上架：已上架</p></aside>`
    : "";
  const tooltip = settings.tooltipMissing
    ? ""
    : `<div id="EquipTipsBox" role="tooltip" style="display:none;white-space:pre-line">${escape(settings.name + "\n" + settings.description)}</div>`;
  return `<meta charset="utf-8"><title>装备详情结构模拟页</title>
${settings.onlyRecommendation ? recommend : settings.recommendFirst ? recommend + main : main + recommend}${tooltip}
<div id="RecommendedTipsBox" role="tooltip" style="display:none;white-space:pre-line">${escape(recommendedName + "\n" + settings.description.replace("防御：50", "防御：99"))}</div>
<script>
window.IsLogin=1;window.hovers=[];window.tooltipDelay=${settings.tooltipDelay};
${settings.rawPrice ? `window.equip={price:${settings.price * 100},equip_name:${JSON.stringify(settings.rawName || settings.name)},eid:${settings.rawEid ? JSON.stringify(settings.rawEid) : "new URL(location.href).searchParams.get('eid')"},serverid:1};` : ""}
window.showTip=function(id){hovers.push(id);setTimeout(()=>{const tip=document.getElementById(id);if(tip)tip.style.display='block';},tooltipDelay);};
</script>`;
}

export const roleSentinelDocument = `<meta charset="utf-8"><title>原角色列表</title>
<p>原角色列表，第7页</p><script>window.QueryArgs={server_type:'3',page:7,order_by:'selling_time DESC'};window.checkpoint={key:'367:kept-role',page:7};</script>`;
