import { test } from "node:test";
import assert from "node:assert/strict";
import { markerFromLookup, parseEnvironRunMarker, parseMacRunMarker } from "../src/runmarker.js";

test("run marker 只提取 service/runId 白名单字段", () => {
  const marker = markerFromLookup((key) => ({
    PORTMARSHAL_SERVICE: "web",
    PORTMARSHAL_RUN_ID: "run-123",
    SECRET_TOKEN: "must-not-leak",
  })[key]);
  assert.deepEqual(marker, { service: "web", runId: "run-123" });
});

test("parseEnvironRunMarker 解析 NUL 分隔环境", () => {
  assert.deepEqual(
    parseEnvironRunMarker("PORT=3000\0PORTMARSHAL_SERVICE=api\0PORTMARSHAL_RUN_ID=uuid-1\0SECRET=x\0"),
    { service: "api", runId: "uuid-1" },
  );
});

test("parseMacRunMarker 从 ps eww 输出提取标记", () => {
  assert.deepEqual(
    parseMacRunMarker("node server.js PORT=3000 PORTMARSHAL_SERVICE=web PORTMARSHAL_RUN_ID=uuid-2 SECRET=x\n"),
    { service: "web", runId: "uuid-2" },
  );
});
