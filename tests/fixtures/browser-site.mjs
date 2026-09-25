export const html = (body, loggedIn = false) => `<meta charset="utf-8"><title>隔离测试藏宝阁</title>
  <script>var IsLogin=${loggedIn ? 1 : 0};var LoginInfo=${loggedIn ? JSON.stringify({ login: 1, nickname: "测试角色", server_name: "测试服务器", roleid: "123" }) : "{}"};</script>${body}`;

export const login = html(`<div id="loginContainer">
  <div id="qrcode"><canvas width="160" height="160"></canvas></div>
  <div class="popupDialog" style="display:none">其他服务器有角色 <button onclick="this.parentElement.style.display='none'; document.querySelector('#roles').style.display='block'">我知道了</button></div>
  <div id="roles" style="display:none"><ul id="role_list_panel"><li id="role_el_123"><img alt="角色" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" onclick="window.roleSelected=true">测试角色</li></ul>
    <a id="login_btn" onclick="if(!window.roleSelected) throw Error('未选角色'); window.submits=(window.submits||0)+1; sessionStorage.setItem('submits',window.submits); location.href='/cgi-bin/query.py'">进入服务器</a></div>
  </div><script>addEventListener('test-scan',()=>{document.querySelector('#qrcode').style.display='none';document.querySelector('.popupDialog').style.display='block'})</script>`);

export const authenticated = (body) =>
  html(
    `<a href="show_login.py">通用登录入口</a><a href="logout.py?act=logout">退出</a>${body}`,
    true,
  );

export const equipment =
  authenticated(`<ul id="server_type_panel"><li>3年以上服</li><li class="on">1到3年服</li><li>1年内服</li></ul>
  <script>document.querySelectorAll('#server_type_panel li').forEach(li=>li.onclick=()=>li.classList.toggle('on'))</script>
  <a id="sub_role" href="/cgi-bin/xyq_overall_search.py?act=show_search_role_form" onclick="if(document.querySelectorAll('#server_type_panel li.on').length!==1||document.querySelector('#server_type_panel li.on').innerText!=='3年以上服'){event.preventDefault();throw Error('开服时间未选择')}" target="_blank">角色搜索</a>`);

export const roleForm =
  authenticated(`<script>var QueryArgs={serverid:'367'};</script><div id="advance_search_box"><button class="js_form_title" data-title="转服搜索" onclick="document.querySelector('#server_type').style.display='block'">转服搜索</button>
  <ul id="server_type" style="display:none"><li data_value="1" class="on"><span>1年以内服</span></li><li data_value="2"><span>1到3年服</span></li><li data_value="3"><span>3年以上服</span></li></ul></div>
  <form name="query_form" method="post" target="_blank" action="/cgi-bin/xyq_overall_search.py"><input name="act" value="show_role_search_result"><input name="args" id="query_args"></form>
  <a id="btn_do_query" onclick="document.querySelector('#query_args').value=JSON.stringify({serverid:'367',server_type:[...document.querySelectorAll('#server_type li.on')].map(li=>li.getAttribute('data_value')).join(',')});document.query_form.submit()">全服搜索</a>
  <script>document.querySelectorAll('#server_type li').forEach(li=>li.onclick=()=>li.classList.toggle('on'))</script>`);

export const roleResults =
  authenticated(`<script>var QueryArgs={server_type:'3'};var CaptchaCheck={need_captcha:false};</script>
  <div id="query_result">加载中</div><script>setTimeout(()=>{document.querySelector('#query_result').innerHTML='<table id="soldList"><tr><th>角色</th><th>等级</th><th>服务器</th><th>价格</th></tr><tr><td>测试剑侠客</td><td>175</td><td>测试服务器</td><td>¥ 10,000</td></tr></table>'},500)</script>`);

export const home = html(
  '<a id="server_pos_1_a" href="/cgi-bin/show_login.py" target="_blank">测试服务器</a>',
);

export const postLogin = authenticated(
  '<a id="cross_server_buy" href="/cgi-bin/equipquery.py?act=show_overall_search_equip" target="_blank">跨服购买</a>',
);

export const fallback = html("测试页面");

export const idleCrawlStatus = {
  running: false,
  phase: "idle",
  message: "采集待开始",
  page: 0,
  totalPages: 0,
  saved: 0,
  skipped: 0,
  totalSaved: 0,
  database: "test.sqlite",
  recent: [],
};
