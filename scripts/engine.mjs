import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL, URL } from "node:url";

export const CONTRACT = Object.freeze({
  website: "https://sharprod.com",
  mcp: "https://mcp.sharprod.com",
  endpoint: "https://mcp.sharprod.com/public",
  maxAttempts: 12,
  timeoutMs: 15000,
  maxBytes: 1048576,
  knowledge: Object.freeze({
    sourceSiteSha: "1637c07e33ffe9680394b4b5031ec39d70f67023",
    registrySha256: "2d8b269f015c84ae795c2c0a133ef9dd8743a9769fcaeafd174ae2871df95924",
    contentVersion: "3.1.2",
  }),
  tools: Object.freeze([
    "search_knowledge",
    "list_services",
    "get_service",
    "get_price",
    "compare_production_methods",
    "search_cases",
    "get_case",
    "get_public_evidence",
    "get_organization_facts",
    "get_public_clients",
    "get_industry_experience",
    "get_timeline_context",
    "get_deliverables",
    "get_brief_requirements",
    "get_media_provenance",
  ]),
});

export const REQUESTS = Object.freeze(
  [
    { id: "home", url: `${CONTRACT.website}/` },
    { id: "leadMethodGuard", url: `${CONTRACT.website}/send.php` },
    { id: "websiteRobots", url: `${CONTRACT.website}/robots.txt` },
    { id: "mcpRobots", url: `${CONTRACT.mcp}/robots.txt` },
    { id: "sitemap", url: `${CONTRACT.website}/sitemap.xml` },
    { id: "contactsAlias", url: `${CONTRACT.website}/contacts.html?monitor=alias` },
    { id: "contact", url: `${CONTRACT.website}/contact.html` },
    { id: "tools", url: CONTRACT.endpoint },
    { id: "serverCard", url: `${CONTRACT.mcp}/.well-known/mcp/server-card.json` },
    { id: "websiteLineage", url: `${CONTRACT.website}/.well-known/shar-mcp.json` },
  ].map(Object.freeze),
);

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const assert = (condition, code) => {
  if (!condition) throw new Error(code);
};
const attributes = (tag) =>
  Object.fromEntries(
    [...tag.matchAll(/([:\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/gu)].map((m) => [
      m[1].toLowerCase(),
      m[2] ?? m[3],
    ]),
  );

function checkHtml(observation, canonical) {
  assert(/text\/html\b/iu.test(observation.headers["content-type"] || ""), "HTML_MEDIA_TYPE");
  const links = [...observation.body.matchAll(/<link\b[^>]*>/giu)].map((m) => attributes(m[0]));
  const canonicals = links.filter((x) =>
    (x.rel || "").toLowerCase().split(/\s+/u).includes("canonical"),
  );
  assert(canonicals.length === 1 && canonicals[0].href === canonical, "CANONICAL_MISMATCH");
  const noindex = [...observation.body.matchAll(/<meta\b[^>]*>/giu)]
    .map((m) => attributes(m[0]))
    .some(
      (x) =>
        /^(?:robots|googlebot|yandex)$/iu.test(x.name || "") &&
        /\b(?:noindex|none)\b/iu.test(x.content || ""),
    );
  assert(
    !noindex && !/\b(?:noindex|none)\b/iu.test(observation.headers["x-robots-tag"] || ""),
    "HTML_NOINDEX",
  );
}

function checkRobots(body) {
  const lines = body
    .split(/\r?\n/u)
    .map((x) => x.replace(/#.*$/u, "").trim())
    .filter(Boolean);
  const signals = lines.filter((x) => /^Content-Signal:/iu.test(x)).join(", ");
  for (const key of ["search", "ai-input", "ai-train"]) {
    assert(
      new RegExp(`${key}\\s*=\\s*yes(?:\\s*[,;]|\\s*$)`, "iu").test(signals),
      "PUBLIC_BOT_POLICY",
    );
    assert(
      !new RegExp(`${key}\\s*=\\s*no(?:\\s*[,;]|\\s*$)`, "iu").test(signals),
      "PUBLIC_BOT_POLICY",
    );
  }
  // Denials of private paths are expected. A complete root ban is a regression.
  const groups = [];
  let group = { agents: [], rules: [] };
  for (const line of lines) {
    const match = /^([^:]+):\s*(.*)$/u.exec(line);
    if (!match) continue;
    const name = match[1].toLowerCase(),
      value = match[2];
    if (name === "user-agent") {
      if (group.rules.length) {
        groups.push(group);
        group = { agents: [], rules: [] };
      }
      group.agents.push(value.toLowerCase());
    } else if (name === "allow" || name === "disallow") group.rules.push({ name, value });
  }
  groups.push(group);
  const publicAgents = new Set([
    "*",
    "gptbot",
    "oai-searchbot",
    "chatgpt-user",
    "claudebot",
    "ccbot",
    "google-extended",
    "applebot-extended",
    "meta-externalagent",
    "amazonbot",
    "googlebot",
    "bingbot",
    "yandex",
  ]);
  for (const current of groups)
    if (current.agents.some((x) => publicAgents.has(x))) {
      const rootDenied = current.rules.some((x) => x.name === "disallow" && x.value === "/");
      const rootAllowed = current.rules.some((x) => x.name === "allow" && x.value === "/");
      assert(!rootDenied || rootAllowed, "PUBLIC_BOT_ROOT_DENIED");
    }
}

function sitemapCount(xml) {
  // A small non-validating XML parser: enforce balanced markup before reading locs.
  // DTD/entity expansion is deliberately unsupported in this public sitemap check.
  const stack = [];
  let cursor = 0,
    rootCount = 0;
  const tokens = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<\/?[\w:.-]+\b[^>]*>|[^<]+/gu;
  for (const match of xml.matchAll(tokens)) {
    assert(match.index === cursor, "SITEMAP_XML");
    cursor += match[0].length;
    const token = match[0];
    if (token.startsWith("<!--") || token.startsWith("<?")) continue;
    if (!token.startsWith("<")) {
      assert(stack.length > 0 || !token.trim(), "SITEMAP_XML");
      continue;
    }
    const name = /^<\/?([\w:.-]+)/u.exec(token)[1];
    if (token.startsWith("</")) assert(stack.pop() === name, "SITEMAP_XML");
    else {
      if (!stack.length) {
        rootCount++;
        assert(name === "urlset", "SITEMAP_XML");
      }
      if (!token.endsWith("/>")) stack.push(name);
    }
  }
  assert(cursor === xml.length && stack.length === 0 && rootCount === 1, "SITEMAP_XML");
  assert(/<urlset\b[^>]*>[\s\S]*<\/urlset>\s*$/u.test(xml), "SITEMAP_XML");
  const entries = [...xml.matchAll(/<url\b[^>]*>([\s\S]*?)<\/url>/gu)];
  assert(
    entries.length > 0 &&
      entries.length <= 2000 &&
      entries.length === (xml.match(/<url\b/gu) || []).length,
    "SITEMAP_ENTRIES",
  );
  const urls = entries.map((m) => {
    const locs = [...m[1].matchAll(/<loc>\s*([^<]+)\s*<\/loc>/gu)];
    assert(locs.length === 1, "SITEMAP_LOC");
    const url = new URL(locs[0][1].trim().replaceAll("&amp;", "&"));
    assert(url.origin === CONTRACT.website && !url.search && !url.hash, "SITEMAP_CANONICAL_ORIGIN");
    return url.href;
  });
  assert(new Set(urls).size === urls.length, "SITEMAP_DUPLICATES");
  return urls.length;
}

export function evaluate(observations) {
  const checks = [],
    metrics = {},
    lineage = {},
    assessments = [];
  for (const spec of REQUESTS) {
    const observed = observations[spec.id];
    try {
      assert(observed && !observed.error, observed?.error || "MISSING_OBSERVATION");
      assert(
        observed.status ===
          (spec.id === "contactsAlias" ? 301 : spec.id === "leadMethodGuard" ? 405 : 200),
        `HTTP_${observed.status}`,
      );
      const json = () => {
        try {
          if (
            spec.id === "tools" &&
            (/text\/event-stream/iu.test(observed.headers["content-type"] || "") ||
              /^(?:event:|data:)/u.test(observed.body))
          ) {
            const events = observed.body
              .split(/\r?\n\r?\n/u)
              .map((block) =>
                block
                  .split(/\r?\n/u)
                  .filter((line) => line.startsWith("data:"))
                  .map((line) => line.slice(5).trimStart())
                  .join("\n"),
              )
              .filter(Boolean)
              .map((value) => JSON.parse(value));
            const payload = events.find((value) => value.id === 1 && (value.result || value.error));
            assert(payload, "MCP_SSE_RESULT_MISSING");
            return payload;
          }
          return JSON.parse(observed.body);
        } catch {
          throw new Error("INVALID_JSON");
        }
      };
      if (spec.id === "home") checkHtml(observed, `${CONTRACT.website}/`);
      if (spec.id === "contact") checkHtml(observed, `${CONTRACT.website}/contact.html`);
      if (spec.id === "leadMethodGuard") {
        assert(
          /^application\/json(?:\s*;|\s*$)/iu.test(observed.headers["content-type"] || ""),
          "LEAD_METHOD_MEDIA_TYPE",
        );
        const value = json();
        assert(
          value.success === false && value.error_code === "method_not_allowed",
          "LEAD_METHOD_GUARD",
        );
      }
      if (spec.id.endsWith("Robots")) checkRobots(observed.body);
      if (spec.id === "sitemap") metrics.sitemapUrls = sitemapCount(observed.body);
      if (spec.id === "contactsAlias") {
        assert(observed.headers.location, "CONTACT_LOCATION_MISSING");
        assert(
          new URL(observed.headers.location, spec.url).href ===
            `${CONTRACT.website}/contact.html?monitor=alias`,
          "CONTACT_ALIAS_TARGET",
        );
      }
      if (spec.id === "tools") {
        const tools = json().result?.tools;
        assert(Array.isArray(tools) && tools.length === 15, "MCP_TOOL_COUNT");
        assert(
          JSON.stringify(tools.map((x) => x.name).sort()) ===
            JSON.stringify([...CONTRACT.tools].sort()),
          "MCP_TOOL_NAMES",
        );
        assert(
          tools.every(
            (x) => x.annotations?.readOnlyHint === true && x.annotations?.destructiveHint !== true,
          ),
          "MCP_NOT_READ_ONLY",
        );
        metrics.readOnlyTools = tools.length;
        metrics.writeTools = 0;
      }
      if (spec.id === "serverCard") {
        const card = json(),
          metadata = card._meta?.["com.sharprod/discovery"];
        assert(
          card.remotes?.some((x) => x.url === CONTRACT.endpoint),
          "MCP_ENDPOINT_DRIFT",
        );
        assert(metadata?.knowledgeProvenance, "MCP_LINEAGE_MISSING");
        for (const [key, expected] of Object.entries(CONTRACT.knowledge))
          assert(metadata.knowledgeProvenance[key] === expected, `MCP_KNOWLEDGE_${key}`);
        lineage.knowledge = metadata.knowledgeProvenance;
        lineage.agenticRelease = metadata.agenticRelease ?? null;
        const runtime = metadata.agenticRelease;
        const observable =
          /^[a-f0-9]{40}$/u.test(runtime?.applicationSha || "") &&
          /^sha256:[a-f0-9]{64}$/u.test(runtime?.imageDigest || "");
        if (runtime?.canonicalEndpoint)
          assert(runtime.canonicalEndpoint === CONTRACT.endpoint, "AGENTIC_RUNTIME_ENDPOINT_DRIFT");
        assessments.push({
          scope: "agentic_runtime_release",
          status: observable ? "OBSERVED" : "UNASSESSED",
          reason: observable
            ? "Public server card exposes runtime commit and image digest"
            : "Public server card does not expose a complete runtime commit/image observation",
        });
      }
      if (spec.id === "websiteLineage") {
        const manifest = json();
        assert(
          manifest.endpoint === CONTRACT.endpoint && manifest.readOnly === true,
          "WEBSITE_MCP_CONTRACT",
        );
        const expected = CONTRACT.knowledge;
        assert(
          manifest.lineage?.source_site_sha === expected.sourceSiteSha &&
            manifest.lineage?.registry_sha256 === expected.registrySha256 &&
            manifest.lineage?.content_version === expected.contentVersion,
          "WEBSITE_FROZEN_KNOWLEDGE_DRIFT",
        );
        lineage.websiteMcpKnowledge = manifest.lineage;
      }
      checks.push({ id: spec.id, ok: true, code: "PASS" });
    } catch (error) {
      checks.push({ id: spec.id, ok: false, code: error.message });
    }
  }
  return { ok: checks.every((x) => x.ok), checks, metrics, lineage, assessments };
}

export function deduplicate(previous, result, now) {
  const failures = result.checks
    .filter((x) => !x.ok)
    .map(({ id, code }) => ({ id, code }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const fingerprint = result.ok ? null : sha256(JSON.stringify(failures));
  const status = result.ok ? "pass" : "fail";
  let event = null;
  if (!result.ok && (previous?.status !== "fail" || previous.fingerprint !== fingerprint))
    event = { type: "failure", at: now, fingerprint, failures };
  if (result.ok && previous?.status === "fail")
    event = { type: "recovery", at: now, previousFingerprint: previous.fingerprint };
  return {
    state: {
      schemaVersion: "1.0.0",
      status,
      fingerprint,
      lastCheckedAt: now,
      lastEventAt: event ? now : (previous?.lastEventAt ?? null),
    },
    event,
  };
}

export async function boundedBody(response) {
  const tooLarge = () => Object.assign(new Error("RESPONSE_TOO_LARGE"), { retryable: false });
  const contentLength = Number(new Map(response.headers).get("content-length"));
  if (contentLength > CONTRACT.maxBytes) throw tooLarge();
  if (!response.body?.getReader) {
    const raw = Buffer.from(await response.arrayBuffer());
    if (raw.length > CONTRACT.maxBytes) throw tooLarge();
    return raw;
  }
  const reader = response.body.getReader(),
    chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > CONTRACT.maxBytes) {
      await reader.cancel();
      throw tooLarge();
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

export async function collect({ fetchImpl = globalThis.fetch } = {}) {
  let total = 0;
  const observations = {};
  for (let index = 0; index < REQUESTS.length; index++) {
    const spec = REQUESTS[index],
      attempts = [];
    const headers = { accept: "*/*", "user-agent": "SHAR-Light-Monitor/1.0" };
    const init = { method: "GET", redirect: "manual", headers };
    if (spec.id === "leadMethodGuard") headers.accept = "application/json";
    if (spec.id === "tools") {
      init.method = "POST";
      headers.accept = "application/json, text/event-stream";
      headers["content-type"] = "application/json";
      headers["mcp-protocol-version"] = "2026-07-28";
      headers["mcp-method"] = "tools/list";
      init.body = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientInfo": { name: "shar-light-monitor", version: "1.0.0" },
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      });
    }
    for (let attempt = 1; attempt <= 2; attempt++) {
      if (total >= CONTRACT.maxAttempts) {
        observations[spec.id] = { error: "ATTEMPT_BUDGET_EXHAUSTED", attempts };
        break;
      }
      total++;
      const started = Date.now();
      try {
        const response = await fetchImpl(spec.url, {
          ...init,
          signal: globalThis.AbortSignal.timeout(CONTRACT.timeoutMs),
        });
        const headers = Object.fromEntries(
          [...response.headers].filter(([name]) =>
            [
              "content-type",
              "location",
              "cache-control",
              "age",
              "expires",
              "etag",
              "last-modified",
              "vary",
              "x-robots-tag",
            ].includes(name.toLowerCase()),
          ),
        );
        const raw = await boundedBody(response);
        if (raw.length > CONTRACT.maxBytes) {
          attempts.push({
            attempt,
            at: new Date().toISOString(),
            status: response.status,
            durationMs: Date.now() - started,
            error: "RESPONSE_TOO_LARGE",
          });
          observations[spec.id] = { error: "RESPONSE_TOO_LARGE", attempts };
          break;
        }
        attempts.push({
          attempt,
          at: new Date().toISOString(),
          status: response.status,
          durationMs: Date.now() - started,
        });
        observations[spec.id] = {
          status: response.status,
          headers,
          body: raw.toString("utf8"),
          sha256: sha256(raw),
          bytes: raw.length,
          attempts,
        };
        break;
      } catch (error) {
        if (error?.retryable === false) {
          attempts.push({
            attempt,
            at: new Date().toISOString(),
            durationMs: Date.now() - started,
            error: error.message,
          });
          observations[spec.id] = { error: error.message, attempts };
          break;
        }
        const timeout = ["TimeoutError", "AbortError"].includes(error?.name);
        attempts.push({
          attempt,
          at: new Date().toISOString(),
          durationMs: Date.now() - started,
          error: timeout ? "TRANSPORT_TIMEOUT" : "TRANSPORT_FAILURE",
        });
        const remainingUnstarted = REQUESTS.length - index - 1;
        if (attempt === 2 || total + remainingUnstarted >= CONTRACT.maxAttempts) {
          observations[spec.id] = {
            error: timeout ? "TRANSPORT_TIMEOUT" : "TRANSPORT_FAILURE",
            attempts,
          };
          break;
        }
      }
    }
  }
  return observations;
}

async function main() {
  const args = process.argv.slice(2);
  const option = (name, fallback) =>
    args.find((x) => x.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
  const stateFile = resolve(option("state", ".shar-light-monitor-state.json"));
  const outputFile = option("output", null);
  if (outputFile && resolve(outputFile) === stateFile)
    throw new Error("Output must not overwrite state");
  let previous = null;
  try {
    previous = JSON.parse(await readFile(stateFile, "utf8"));
    assert(
      previous.schemaVersion === "1.0.0" &&
        ["pass", "fail"].includes(previous.status) &&
        (previous.fingerprint === null || typeof previous.fingerprint === "string"),
      "STATE_SCHEMA_INVALID",
    );
  } catch (error) {
    if (error.code !== "ENOENT")
      throw new Error("Monitor state cannot be read; refusing to erase dedup history", {
        cause: error,
      });
  }
  const startedAt = new Date().toISOString(),
    observations = await collect();
  const result = evaluate(observations),
    finishedAt = new Date().toISOString();
  const transition = deduplicate(previous, result, finishedAt);
  const report = {
    schemaVersion: "1.0.0",
    startedAt,
    finishedAt,
    ...result,
    event: transition.event,
    requestAttempts: Object.values(observations).reduce((n, x) => n + x.attempts.length, 0),
    observations: Object.fromEntries(
      Object.entries(observations).map(([key, value]) => {
        const { body, ...summary } = value;
        return [key, { ...summary, ...(body ? { bodyCaptured: false } : {}) }];
      }),
    ),
  };
  await mkdir(dirname(stateFile), { recursive: true });
  const temporary = `${stateFile}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(transition.state, null, 2) + "\n", { flag: "wx" });
  await rename(temporary, stateFile);
  if (outputFile) {
    await mkdir(dirname(resolve(outputFile)), { recursive: true });
    await writeFile(outputFile, JSON.stringify(report, null, 2) + "\n");
  }
  console.log(JSON.stringify(report, null, 2));
  if (!result.ok) process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch(() => {
    console.error(JSON.stringify({ ok: false, code: "MONITOR_LOCAL_STATE_ERROR" }));
    process.exitCode = 4;
  });
