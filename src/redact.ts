const REDACTED = "[REDACTED]";
const SENSITIVE_CORE = "(?:api[-_]?key|access[-_]?token|refresh[-_]?token|auth(?:orization)?|bearer|client[-_]?secret|csrf[-_]?token|cookie|pass(?:word|wd)?|secret|session[-_]?token|token)";
// 覆盖 OPENAI_API_KEY、GITHUB_TOKEN、DATABASE_PASSWORD、X-Auth-Token 等带命名空间的常见形式。
const SENSITIVE_KEY = `(?:(?:[a-z0-9]+[-_.])*)${SENSITIVE_CORE}`;
const VALUE = "(?:\\\"[^\\\"]*\\\"|'[^']*'|[^\\s]+)";

/**
 * CLI/JSON 输出边界的保守脱敏。保留参数名和命令结构，隐藏常见凭证值；
 * 项目路径推断必须在调用本函数之前使用原始命令完成。
 */
export function redactCommand(command: string): string {
  let out = command;

  // --token=value / -password=value
  out = out.replace(
    new RegExp(`((?:^|\\s)--?${SENSITIVE_KEY}\\s*=\\s*)${VALUE}`, "gi"),
    `$1${REDACTED}`,
  );
  // --token value / -password value
  out = out.replace(
    new RegExp(`((?:^|\\s)--?${SENSITIVE_KEY}\\s+)${VALUE}`, "gi"),
    `$1${REDACTED}`,
  );
  // TOKEN=value / PASSWORD=value
  out = out.replace(
    new RegExp(`((?:^|\\s)${SENSITIVE_KEY}\\s*=\\s*)${VALUE}`, "gi"),
    `$1${REDACTED}`,
  );
  // Quoted header arguments may contain spaces (especially Cookie); redact the whole quoted value.
  out = out.replace(
    new RegExp(`(["'])(${SENSITIVE_KEY}\\s*:\\s*)(?:(?:bearer|basic)\\s+)?[^"'\\r\\n]*\\1`, "gi"),
    `$1$2${REDACTED}$1`,
  );
  // Authorization: Bearer/Basic xxx / X-API-Key: xxx / Cookie: xxx
  out = out.replace(
    new RegExp(`(${SENSITIVE_KEY}\\s*:\\s*)(?:(?:bearer|basic)\\s+)?[^\\s'\\\"]+`, "gi"),
    `$1${REDACTED}`,
  );
  out = out.replace(/(\bbearer\s+)[^\s'\"]+/gi, `$1${REDACTED}`);
  // https://user:password@example.com
  out = out.replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^\s\/:@]+:)[^\s\/@]+@/gi, `$1${REDACTED}@`);
  // ?token=x / &api_key=x
  out = out.replace(
    new RegExp(`([?&]${SENSITIVE_KEY}=)[^&#\\s]*`, "gi"),
    `$1${REDACTED}`,
  );
  return out;
}
