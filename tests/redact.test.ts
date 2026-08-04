import { test } from "node:test";
import assert from "node:assert/strict";
import { redactCommand } from "../src/redact.js";

test("redactCommand 隐藏常见敏感 flag、赋值、Bearer、URL 凭证与查询参数", () => {
  const command = [
    "node server.js",
    "--csrf_token csrf-value",
    "--api-key=api-value",
    "PASSWORD=pass-value",
    "OPENAI_API_KEY=openai-value",
    "--header 'Authorization: Bearer bearer-value'",
    "--header \"Authorization: Basic basic-value\"",
    "--header 'Cookie: session=cookie-value; csrf=cookie-csrf-value'",
    "https://alice:url-password@example.com/path?token=query-value&ok=1",
    "--port 3000",
  ].join(" ");
  const redacted = redactCommand(command);

  for (const secret of [
    "csrf-value", "api-value", "pass-value", "openai-value", "bearer-value", "basic-value",
    "cookie-value", "cookie-csrf-value", "url-password", "query-value",
  ]) {
    assert.equal(redacted.includes(secret), false, `不得保留 ${secret}`);
  }
  assert.match(redacted, /\[REDACTED\]/);
  assert.match(redacted, /--port 3000/);
  assert.match(redacted, /ok=1/);
});

test("redactCommand 保留普通命令结构且幂等", () => {
  const command = "pnpm vite --port 5173 --host 127.0.0.1";
  assert.equal(redactCommand(command), command);
  assert.equal(redactCommand(redactCommand("cmd --token value")), redactCommand("cmd --token value"));
});
