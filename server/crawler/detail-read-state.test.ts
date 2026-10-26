import { describe, expect, it } from "vite-plus/test";
import { DetailReadState } from "./detail-read-state";
import type { TabSnapshot } from "./types";

describe("同件详情的本轮标签检查点", () => {
  const tab: TabSnapshot = {
    name: "技能",
    text: "已读",
    fields: [],
    tables: [],
    elements: [],
    tooltips: [],
    items: [],
  };
  it("相同来源版本保留完成标签，读写互不改动已有快照", () => {
    const state = new DetailReadState();
    state.begin("role-a/revision-a");
    state.save("技能", [tab]);
    const read = state.get("技能")!;
    read.tabs[0].text = "外部改动";
    state.begin("role-a/revision-a");
    expect(state.get("技能")!.tabs[0].text).toBe("已读");
  });
  it.each([null, "role-b/revision-a", "role-a/revision-b"])(
    "身份、原文或凭据变化%s清除本轮复用",
    (revision) => {
      const state = new DetailReadState();
      state.begin("role-a/revision-a");
      state.save("技能", [tab]);
      state.begin(revision);
      expect(state.get("技能")).toBeUndefined();
      state.save("技能", [tab]);
      if (!revision) expect(state.get("技能")).toBeUndefined();
    },
  );
});
