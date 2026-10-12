import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { chromium, type Browser } from "playwright-core";
import { valuationRecord } from "../../tests/fixtures/analysis";
import { rolePricingRecord } from "../../tests/fixtures/role-pricing";
import { assertAvailable } from "../crawler/page";
import {
  applyRoleSearchSelections,
  assertRoleFormReadable,
  clickRoleSearchPage,
  createRoleSource,
  readRoleAuthentication,
  readRoleSearchForm,
  selectRoleSearchAge,
} from "./browser-role-source";
import { buildRoleSearchQuery } from "./role-search-query";

const session = vi.hoisted(() => ({
  getBrowser: vi.fn(),
  createHiddenPage: vi.fn(),
  getCbgPage: vi.fn(),
  waitList: vi.fn(),
  readListings: vi.fn(),
  isOnShelf: vi.fn(),
  collectDetail: vi.fn(),
}));
vi.mock("../session", () => session);
vi.mock("../crawler/detail", () => ({
  isOnShelf: session.isOnShelf,
  collectDetail: session.collectDetail,
}));
vi.mock("../crawler/page", async (original) => ({
  ...(await original<typeof import("../crawler/page")>()),
  waitList: session.waitList,
  readListings: session.readListings,
}));

/** Isolated synthetic pages only; no existing Chrome session or live website is accessed. */
describe("公开角色表单与价格认证边界", () => {
  let browser: Browser;
  beforeAll(async () => {
    session.waitList.mockRejectedValue(new Error("fixture: reached list wait"));
    browser = await chromium.launch({ channel: "chrome", headless: true });
  });
  afterAll(async () => {
    await browser?.close();
  });
  const publicForm = `<meta charset="utf-8"><div><form name="query_form" action="/cgi-bin/xyq_overall_search.py" method="post"><input type="hidden" name="act" value="observed-fixture"><input type="hidden" name="private-token" value="do-not-export"><label for="observed-grade">等级</label><input id="observed-grade" name="observed-grade"><ul id="observed-school"><li data_value="observed-school-id">神木林</li></ul></form></div><script>window.IsLogin=0;window.LoginInfo={login:0,urs:'do-not-export',nickname:'do-not-export'};</script>`;
  const show = async (
    html: string,
    path = "/cgi-bin/xyq_overall_search.py?act=observed-fixture",
  ) => {
    const page = await browser.newPage();
    await page.route("**/*", (route) =>
      new URL(route.request().url()).origin === "https://xyq.cbg.163.com"
        ? route.fulfill({ contentType: "text/html", body: html })
        : route.abort(),
    );
    await page.goto("https://xyq.cbg.163.com" + path);
    return page;
  };
  const uiForm = (level: number, school: string) => `<meta charset="utf-8">
    <form name="query_form" action="/cgi-bin/equipquery.py"><input type="hidden" name="act" value="fixture-role-result"></form>
    <div id="test"><table class="searcTb">
    <tr><th>人物等级：</th><td><input id="level_min"><input id="level_max"><input id="unused_filter" value="777"></td></tr>
    <tr><th>门派：</th><td><ul id="school_list"><li data_value="different" class="on">其他门派</li><li data_value="${level + 100}">${school}</li></ul></td></tr>
    <tr><th>附加配置：</th><td><select id="observed-select"><option value="">不限</option><option value="preset" selected>预设</option><option value="selected">目标选项</option></select></td></tr>
    <tr><th>转服搜索：</th><td><ul id="server_type"><li data_value="2" class="on">1到3年服</li><li data_value="3">3年以上服</li></ul></td></tr>
    </table></div><aside><input id="type_box" value="private-qa"></aside>
    <button id="btn_do_query">查询</button><div id="pager_bar"><a href="javascript:goto(2)">下一页</a></div>
    <script>window.IsLogin=0;window.LoginInfo={login:0};window.uiEvents=[];window.goto=function(page){window.clickedPage=page};
    document.querySelectorAll('input,select').forEach(function(node){node.addEventListener('input',function(event){window.uiEvents.push({id:node.id,type:'input',trusted:event.isTrusted})})});
    document.querySelectorAll('li').forEach(function(node){node.addEventListener('click',function(event){node.classList.toggle('on');window.uiEvents.push({id:node.parentElement.id,type:'click',trusted:event.isTrusted})})});
    document.getElementById('btn_do_query').addEventListener('click',function(event){window.uiEvents.push({id:'btn_do_query',type:'click',trusted:event.isTrusted});window.submittedPublic={min:document.getElementById('level_min').value,max:document.getElementById('level_max').value,school:document.querySelector('#school_list li.on').getAttribute('data_value'),age:document.querySelector('#server_type li.on').getAttribute('data_value')}});</script>`;
  it.each([
    [70, "大唐官府"],
    [109, "神木林"],
    [175, "女儿村"],
  ])("%s级%s生成的条件通过实际输入、菜单与按钮点击完成", async (level, school) => {
    const page = await show(uiForm(level, school));
    try {
      const target = valuationRecord();
      const person = target.detail!.tabs.find((tab) => tab.name === "人物/修炼")!;
      person.fields.find((field) => field.name === "级别")!.value = String(level);
      person.fields.push({ name: "门派", value: school });
      const form = await readRoleSearchForm(page);
      const plan = buildRoleSearchQuery(target, form);
      plan.controls.push({ id: "observed-select", value: "selected" });
      await applyRoleSearchSelections(page, form, plan);
      await selectRoleSearchAge(page);
      await page.locator("#btn_do_query").click();
      expect(await page.locator("#unused_filter").inputValue()).toBe("");
      expect(await page.locator("#observed-select").inputValue()).toBe("selected");
      expect(await page.locator("#type_box").inputValue()).toBe("private-qa");
      const proof = await page.evaluate(() => {
        const globals = window as unknown as {
          submittedPublic: Record<string, unknown>;
          uiEvents: { id: string; type: string; trusted: boolean }[];
        };
        return { submittedPublic: globals.submittedPublic, uiEvents: globals.uiEvents };
      });
      expect(proof.submittedPublic).toEqual({
        min: String(level),
        max: String(level),
        school: String(level + 100),
        age: "3",
      });
      for (const id of [
        "level_min",
        "level_max",
        "unused_filter",
        "school_list",
        "server_type",
        "btn_do_query",
      ]) {
        const events = proof.uiEvents.filter((event) => event.id === id);
        expect(events.length).toBeGreaterThan(0);
        expect(events.every((event) => event.trusted)).toBe(true);
      }
      await clickRoleSearchPage(page, 2);
      await page.waitForFunction(
        () => (window as Window & { clickedPage?: number }).clickedPage === 2,
        undefined,
        { timeout: 5000 },
      );
      expect(
        await page.evaluate(() => (window as Window & { clickedPage?: number }).clickedPage),
      ).toBe(2);
      await expect(assertAvailable(page)).rejects.toThrow("登录已失效");
    } finally {
      await page.close();
    }
  });
  it("隐藏的必选控件不能用DOM setter绕过界面", async () => {
    const page = await show(
      uiForm(109, "神木林").replace(
        '<input id="level_min">',
        '<input id="level_min" style="display:none">',
      ),
    );
    try {
      const form = await readRoleSearchForm(page);
      await expect(
        applyRoleSearchSelections(page, form, {
          controls: [{ id: "level_min", value: "109" }],
          menus: [],
        }),
      ).rejects.toThrow("不能通过界面填写");
      expect(await page.locator("#level_min").inputValue()).toBe("");
    } finally {
      await page.close();
    }
  });
  it("IsLogin0的公开form可读字段，同一页不能提供价格证据", async () => {
    const page = await show(publicForm);
    try {
      await expect(assertRoleFormReadable(page)).resolves.toBeUndefined();
      const form = await readRoleSearchForm(page);
      expect(form).toMatchObject({
        act: "observed-fixture",
        controls: [{ id: "observed-grade", label: "等级" }],
        menus: [
          { id: "observed-school", choices: [{ value: "observed-school-id", label: "神木林" }] },
        ],
      });
      expect(JSON.stringify(form)).not.toContain("do-not-export");
      await expect(assertAvailable(page)).rejects.toThrow("登录已失效");
    } finally {
      await page.close();
    }
  });
  it("控件按已观测官网表格读取，hidden form外的等级和门派可读且QA输入被排除", async () => {
    const html =
      publicForm +
      '<aside id="right_float_pannel"><input id="type_box" value="private-qa"></aside><div id="test"><table id="role_basic_panel" class="searcTb"><tr><th>人物等级：</th><td><input id="level_min"><input id="level_max"><ul id="school_list"><li data_value="49">神木林</li></ul></td></tr></table></div>';
    const page = await show(html);
    try {
      const form = await readRoleSearchForm(page);
      expect(form.controls.map((value) => value.id)).toEqual(["level_min", "level_max"]);
      expect(form.menus).toMatchObject([
        { id: "school_list", choices: [{ value: "49", label: "神木林" }] },
      ]);
      expect(JSON.stringify(form)).not.toContain("private-qa");
    } finally {
      await page.close();
    }
  });
  it("玄灵珠默认等级5在关联筛选为空时不阻断搜索或加入查询过滤", async () => {
    const navigation = await show(
      '<a id="sub_role" href="/cgi-bin/xyq_overall_search.py?act=show_search_role_form">角色搜索</a><script>window.IsLogin=1;window.LoginInfo={login:1}</script>',
    );
    const html = `<meta charset="utf-8"><form name="query_form" action="/cgi-bin/xyq_overall_search.py"><input type="hidden" name="act" value="show_role_search_result"></form><div id="test"><table class="searcTb"><tr><th>携带玄灵珠：</th><td><select id="xuan_ling_zhu_type"><option value="">不限</option><option value="1" selected>回春</option></select><select id="xuan_ling_zhu_level"><option value="5">5</option><option value="6">6</option></select></td></tr><tr><td><ul id="server_type"><li class="on" data_value="3">3年以上服</li></ul></td></tr></table></div><button id="btn_do_query" onclick="window.QueryArgs={server_type:3};if(document.getElementById('xuan_ling_zhu_type').value)window.QueryArgs.xuan_ling_zhu_level=document.getElementById('xuan_ling_zhu_level').value">查询</button>`;
    const workPage = await show(html);
    session.getBrowser.mockResolvedValue(browser);
    session.createHiddenPage.mockResolvedValue(workPage);
    session.getCbgPage.mockReturnValue(navigation);
    const source = await createRoleSource(new AbortController().signal);
    try {
      await expect(source.search(valuationRecord(), { controls: [], menus: [] })).rejects.toThrow(
        "fixture: reached list wait",
      );
      expect(await workPage.locator("#xuan_ling_zhu_level").inputValue()).toBe("5");
      expect(await workPage.locator("#xuan_ling_zhu_type").inputValue()).toBe("");
      expect(
        await workPage.evaluate(
          () => (window as Window & { QueryArgs?: Record<string, unknown> }).QueryArgs,
        ),
      ).toEqual({ server_type: 3 });
    } finally {
      await source.close();
      await navigation.close();
    }
  });
  it("诊断只返回公开布尔状态，不返回身份/凭据", async () => {
    const page = await show(publicForm);
    try {
      const diagnostic = await readRoleAuthentication(page);
      expect(diagnostic).toMatchObject({
        pathname: "/cgi-bin/xyq_overall_search.py",
        act: "observed-fixture",
        IsLogin: false,
        login: false,
        hasQR: false,
      });
      expect(JSON.stringify(diagnostic)).not.toContain("do-not-export");
    } finally {
      await page.close();
    }
  });
  it.each(["off_shelf", "read_failure", "identity_failure", "cancelled", "fresh"])(
    "目标重读%s保留实际读取结果或失败原因",
    async (failure) => {
      const navigation = await show(
        '<a id="sub_role" href="/cgi-bin/xyq_overall_search.py?act=show_search_role_form">角色搜索</a><script>window.IsLogin=1;window.LoginInfo={login:1}</script>',
      );
      const html = `<meta charset="utf-8"><form name="query_form" method="post" action="/cgi-bin/xyq_overall_search.py?submitted=1"><input type="hidden" name="act" value="show_role_search_result"><input type="hidden" name="server_type" value="3"><table class="searcTb"><tr><td><ul id="server_type"><li class="on" data_value="3">3年以上服</li></ul></td></tr></table><button id="btn_do_query">查询</button></form><script>window.IsLogin=1;window.LoginInfo={login:1};window.QueryArgs={act:'overall_search_role',server_type:3,page:1};</script>`;
      const workPage = await show(html);
      session.getBrowser.mockResolvedValue(browser);
      session.getCbgPage.mockReturnValue(navigation);
      session.createHiddenPage
        .mockResolvedValueOnce(workPage)
        .mockImplementation(() => browser.newPage());
      session.waitList.mockImplementation((page) => page.waitForURL("**/*submitted=1"));
      session.readListings.mockResolvedValue({ items: [], totalPages: 1 });
      session.isOnShelf.mockResolvedValue(failure !== "off_shelf");
      const controller = new AbortController();
      const target = rolePricingRecord();
      if (failure === "fresh")
        session.collectDetail.mockResolvedValue({
          ...target.detail,
          valuation: {
            ...target.detail!.valuation,
            source: { ...target.detail!.valuation!.source, askingPrice: 5500 },
          },
        });
      if (failure === "read_failure")
        session.collectDetail.mockRejectedValue(new Error("fixture: detail read failure"));
      if (failure === "identity_failure")
        session.collectDetail.mockResolvedValue({
          ...target.detail,
          valuation: { source: { eid: "another", serverId: "33" } },
        });
      if (failure === "cancelled")
        session.isOnShelf.mockImplementation(async () => {
          controller.abort(new Error("fixture: cancelled"));
          controller.signal.throwIfAborted();
        });
      const source = await createRoleSource(controller.signal);
      try {
        if (failure === "fresh") {
          const result = await source.search(target, { controls: [], menus: [] });
          expect(result.target.listing.price).toBe("5500");
          expect(result.target).not.toBe(target);
          return;
        }
        await expect(source.search(target, { controls: [], menus: [] })).rejects.toThrow(
          failure === "off_shelf"
            ? "目标角色已不在售"
            : failure === "read_failure"
              ? "fixture: detail read failure"
              : failure === "identity_failure"
                ? "整号详情身份"
                : "fixture: cancelled",
        );
      } finally {
        await source.close();
        await navigation.close();
        session.waitList.mockRejectedValue(new Error("fixture: reached list wait"));
      }
    },
  );
  it.each([
    ['<div id="qrcode">二维码</div>', "登录面板"],
    ['<div id="loginContainer">扫码登录</div>', "登录面板"],
    ["<script>window.CaptchaCheck={need_captcha:true}</script>", "安全验证"],
    ["<p>访问过于频繁</p>", "降低频率"],
  ])("存在%s拒绝读取，不被public form掩盖", async (extra, message) => {
    const page = await show(publicForm + extra);
    try {
      await expect(assertRoleFormReadable(page)).rejects.toThrow(message);
    } finally {
      await page.close();
    }
  });
  it("实际登录redirect也拒绝公开字段读取", async () => {
    const page = await show(publicForm, "/cgi-bin/show_login.py?act=show_login");
    try {
      await expect(assertRoleFormReadable(page)).rejects.toThrow("登录面板");
    } finally {
      await page.close();
    }
  });
});
