import { afterEach, expect, it, vi } from "vite-plus/test";
import {
  normalizeSavedRecordsView,
  replaceSavedRecordKey,
  replaceSavedRecordsPage,
  savedRecordKey,
  savedRecordsPage,
} from "./saved-view-state";

afterEach(() => vi.unstubAllGlobals());
function locationAt(address: string) {
  const location = new URL(address);
  const replaceState = vi.fn((_state: unknown, _title: string, next: string) => {
    location.href = new URL(next, location.href).href;
  });
  vi.stubGlobal("window", { location, history: { replaceState } });
  return { location, replaceState };
}

it("旧任务范围链接回到商品第1页，不重新打开未完成角色抽屉", () => {
  const { location } = locationAt(
    "http://cbg-ui.test/?recordsScope=tasks&recordsPage=3&record=pending&other=kept#saved",
  );
  expect(savedRecordsPage()).toBe(1);
  expect(savedRecordKey()).toBeNull();
  normalizeSavedRecordsView();
  expect(location.search).toBe("?other=kept");
  expect(location.hash).toBe("#saved");
});

it("正常商品页码和详情深链在清理旧完整范围参数后保留", () => {
  const { location } = locationAt(
    "http://cbg-ui.test/?recordsScope=complete&recordsPage=3&record=complete",
  );
  expect(savedRecordsPage()).toBe(3);
  expect(savedRecordKey()).toBe("complete");
  normalizeSavedRecordsView();
  expect(location.search).toBe("?recordsPage=3&record=complete");
  replaceSavedRecordsPage(2);
  replaceSavedRecordKey(null);
  expect(location.search).toBe("?recordsPage=2");
});

it("没有旧范围时保留地址，非法页码回到第1页", () => {
  const { replaceState } = locationAt("http://cbg-ui.test/?recordsPage=bad");
  normalizeSavedRecordsView();
  expect(replaceState).not.toHaveBeenCalled();
  expect(savedRecordsPage()).toBe(1);
});
