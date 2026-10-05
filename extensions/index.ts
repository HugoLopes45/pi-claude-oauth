import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  createAssistantMessageEventStream,
  normalizeContext,
  type Api,
  type AssistantMessageEvent,
  type Context,
  type Model,
  type ProviderHeaders,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
// Pi's extension loader only aliases the pi-ai root, `/compat`, `/oauth` and
// `/providers/all`. Deeper subpaths such as `/api/anthropic-messages` resolve against the
// compat entry file and make the whole extension fail to load.
import { streamSimpleAnthropic } from "@earendil-works/pi-ai/compat";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const DOCS_MARKER =
  "Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):";
const IDENTITY_BLOCK =
  "You are Claude Code, Anthropic's official CLI for Claude.";
const CUSTOM_TYPE = "claude-oauth-docs-context";
const READY_STATUS_KEY = "claude-oauth-ready";
const ISSUE_STATUS_KEY = "claude-oauth-issue";
const DOCS_OPEN = "<docs>\n";
const DOCS_CLOSE = "\n</docs>";
const PI_TOPIC_REGEX =
  /\b(pi|@mariozechner\/pi-|pi-mono|coding agent harness|pi sdk|pi extension|pi theme|pi skill|pi tui|pi package|prompt templates?|keybindings?|custom providers?|adding models?)\b/i;
const BILLING_SALT = "59cf53e54c78";
// Snapshot at load: catalog models are shared objects that other extensions may mutate.
const CATALOG_WINDOWS = new Map(
  getBuiltinModels("anthropic").map((item) => [item.id, item.contextWindow]),
);
const DEFAULT_ENTRYPOINT = "pi";
const DEFAULT_BILLING_CCH = "00000";
const QUOTA_CHECK_MODEL = "claude-haiku-4-5";
const QUOTA_CHECK_CACHE_TTL_MS = 30_000;
const SURPASSED_THRESHOLD_CLAIMS = [
  { claimAbbrev: "5h", rateLimitType: "five_hour" },
  { claimAbbrev: "7d", rateLimitType: "seven_day" },
  { claimAbbrev: "7d_oi", rateLimitType: "seven_day_overage_included" },
  { claimAbbrev: "overage", rateLimitType: "overage" },
] as const;
const RATE_LIMIT_WARNING_CONFIG = [
  {
    rateLimitType: "five_hour",
    claimAbbrev: "5h",
    windowSeconds: 18_000,
    thresholds: [{ utilization: 0.9, timePct: 0.72 }],
  },
  {
    rateLimitType: "seven_day",
    claimAbbrev: "7d",
    windowSeconds: 604_800,
    thresholds: [
      { utilization: 0.75, timePct: 0.6 },
      { utilization: 0.5, timePct: 0.35 },
      { utilization: 0.25, timePct: 0.15 },
    ],
  },
] as const;

type ReinjectionMode = "none" | "append-custom-message";
type ReinjectionScope = "never" | "always" | "pi-only";
type DocsSource = "system" | "fallback" | "missing";
type BillingHeaderState = "unknown" | "present" | "updated" | "injected";
type AdapterPhase = "inactive" | "ready" | "active" | "warning" | "issue";
type ClaudeRateLimitType =
  | "five_hour"
  | "seven_day"
  | "seven_day_opus"
  | "seven_day_sonnet"
  | "seven_day_overage_included"
  | "overage";
type ClaudeRateLimitStatus = "allowed" | "allowed_warning" | "rejected";
type ClaudeOverageStatus = "allowed" | "allowed_warning" | "rejected";

interface AdapterStatusState {
  phase: AdapterPhase;
  applies: boolean;
  suppressWarning: boolean;
  docsSource: DocsSource;
  billingHeader: BillingHeaderState;
  reason: string;
  statusText: string;
}

interface ClaudeRateLimitState {
  status: ClaudeRateLimitStatus;
  rateLimitType?: ClaudeRateLimitType;
  resetsAt?: number;
  utilization?: number;
  overageStatus?: ClaudeOverageStatus;
  overageResetsAt?: number;
  overageDisabledReason?: string;
  overageInUse?: boolean;
  overageUtilization?: number;
  overageSurpassedThreshold?: number;
  overagePeriodMonthlyUtilization?: number;
  overagePeriodChannelUtilization?: number;
  rateLimitGraceActive?: boolean;
  upgradePaths?: string[];
  unifiedRateLimitFallbackAvailable: boolean;
  isUsingOverage: boolean;
}

interface ClaudeFooterStatus {
  message: string;
  severity: "warning" | "error";
}

type TextBlock = {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral"; ttl?: "1h" };
};

interface PayloadLike {
  system?: unknown;
  messages?: unknown;
  tools?: unknown;
}

interface ResolvedDocsSection {
  extracted: { docsSection: string; strippedPrompt: string } | null;
  docsSection: string | null;
  docsSource: DocsSource;
}

let latestCtx: ExtensionContext | null = null;
let cachedQuotaFooterStatus: {
  keyHash: string;
  value: ClaudeFooterStatus | null;
  checkedAt: number;
} | null = null;
let adapterStatus: AdapterStatusState = {
  phase: "inactive",
  applies: false,
  suppressWarning: false,
  docsSource: "missing",
  billingHeader: "unknown",
  reason: "Not using Anthropic OAuth",
  statusText: "",
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isPayloadLike(value: unknown): value is PayloadLike {
  return isObject(value);
}

function isTextBlock(value: unknown): value is TextBlock {
  return (
    isObject(value) && value.type === "text" && typeof value.text === "string"
  );
}

function getEnvMode(): ReinjectionMode {
  return process.env.PI_CLAUDE_OAUTH_REINJECT_MODE === "none"
    ? "none"
    : "append-custom-message";
}

function getEnvScope(): ReinjectionScope {
  const value = process.env.PI_CLAUDE_OAUTH_REINJECT_SCOPE;
  if (value === "never" || value === "always" || value === "pi-only") {
    return value;
  }
  return "pi-only";
}

export function getClaudeCodeVersion(): string {
  const output = execFileSync("claude", ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 2_000,
  });
  const version = /^(\d+(?:\.\d+)+)(?:\s|$)/.exec(output.trim())?.[1];
  if (!version)
    throw new Error("Could not parse the local Claude Code version");
  return version;
}

function getEntrypoint(): string {
  return (
    process.env.PI_CLAUDE_CODE_ENTRYPOINT ??
    process.env.CLAUDE_CODE_ENTRYPOINT ??
    DEFAULT_ENTRYPOINT
  );
}

function getClaudeCodeWorkload(): string | undefined {
  const workload =
    process.env.PI_CLAUDE_CODE_WORKLOAD ?? process.env.CLAUDE_CODE_WORKLOAD;
  return workload?.trim() ? workload.trim() : undefined;
}

function getClaudeSubscriptionType(): string | undefined {
  const subscriptionType =
    process.env.PI_CLAUDE_CODE_SUBSCRIPTION_TYPE ??
    process.env.CLAUDE_CODE_SUBSCRIPTION_TYPE;
  return subscriptionType?.trim() ? subscriptionType.trim() : undefined;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function getBillingMessageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (block): block is Record<string, unknown> =>
        isObject(block) &&
        block.type === "text" &&
        typeof block.text === "string",
    )
    .map((block) => String(block.text))
    .join("\n");
}

function isFirstPartyAnthropicBaseUrl(baseUrl: string | undefined): boolean {
  const value = baseUrl ?? process.env.ANTHROPIC_BASE_URL;
  if (!value) return true;
  try {
    return new URL(value).host === "api.anthropic.com";
  } catch {
    return false;
  }
}

function getClaudeUserAgent(): string {
  return `claude-cli/${getClaudeCodeVersion()} (external, ${getEntrypoint()})`;
}

function areClientHeadersEnabled(): boolean {
  const value = process.env.PI_CLAUDE_OAUTH_CLIENT_HEADERS;
  return value !== "0" && value !== "false";
}

/**
 * Pi's built-in Anthropic client advertises its own (stale) `claude-cli/<version>` user
 * agent. Anthropic reads the version from the billing system block first and falls back to
 * the user agent, so both have to carry the version this adapter advertises.
 */
export function withClaudeCodeHeaders(
  options: SimpleStreamOptions | undefined,
): SimpleStreamOptions | undefined {
  if (!options || !areClientHeadersEnabled()) return options;

  const headers = Object.fromEntries(
    Object.entries(options.headers ?? {}).filter(([name]) => {
      const normalized = name.toLowerCase();
      return (
        normalized !== "user-agent" &&
        normalized !== "x-app" &&
        normalized !== "x-claude-code-session-id"
      );
    }),
  );
  const claudeCodeHeaders: ProviderHeaders = {
    "user-agent": getClaudeUserAgent(),
    "x-app": "cli",
    ...(options.sessionId
      ? { "x-claude-code-session-id": options.sessionId }
      : {}),
  };

  return { ...options, headers: { ...headers, ...claudeCodeHeaders } };
}

export function buildBillingHeader(
  messages: unknown,
  entrypoint: string = getEntrypoint(),
  includeCch: boolean = isFirstPartyAnthropicBaseUrl(undefined),
): string {
  const list = Array.isArray(messages) ? messages : [];
  const firstUserMessage = list.find(
    (message) => isObject(message) && message.role === "user",
  ) as Record<string, unknown> | undefined;
  const messageText = firstUserMessage
    ? getBillingMessageText(firstUserMessage.content)
    : "";
  const version = getClaudeCodeVersion();
  const sampledChars = [4, 7, 20]
    .map((index) => messageText[index] ?? "0")
    .join("");
  const versionHash = sha256Hex(
    `${BILLING_SALT}${sampledChars}${version}`,
  ).slice(0, 3);
  const workload = getClaudeCodeWorkload();
  const workloadSuffix = workload ? ` cc_workload=${workload};` : "";
  const cchSuffix = includeCch ? ` cch=${DEFAULT_BILLING_CCH};` : "";
  return `x-anthropic-billing-header: cc_version=${version}.${versionHash}; cc_entrypoint=${entrypoint};${cchSuffix}${workloadSuffix}`;
}

function getHeader(
  headers: Record<string, string>,
  name: string,
): string | undefined {
  if (typeof headers[name] === "string") return headers[name];
  const lowerName = name.toLowerCase();
  if (typeof headers[lowerName] === "string") return headers[lowerName];
  const matchedEntry = Object.entries(headers).find(
    ([key]) => key.toLowerCase() === lowerName,
  );
  return matchedEntry?.[1];
}

function parseNumberHeader(
  headers: Record<string, string>,
  name: string,
): number | undefined {
  const value = getHeader(headers, name);
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function hasUnifiedRateLimitHeaders(headers: Record<string, string>): boolean {
  return Object.keys(headers).some((key) =>
    key.toLowerCase().startsWith("anthropic-ratelimit-unified-"),
  );
}

function isClaudeRateLimitType(
  value: string | undefined,
): value is ClaudeRateLimitType {
  return (
    value === "five_hour" ||
    value === "seven_day" ||
    value === "seven_day_opus" ||
    value === "seven_day_sonnet" ||
    value === "seven_day_overage_included" ||
    value === "overage"
  );
}

function isClaudeRateLimitStatus(
  value: string | undefined,
): value is ClaudeRateLimitStatus {
  return (
    value === "allowed" || value === "allowed_warning" || value === "rejected"
  );
}

function isClaudeOverageStatus(
  value: string | undefined,
): value is ClaudeOverageStatus {
  return (
    value === "allowed" || value === "allowed_warning" || value === "rejected"
  );
}

function getResetProgress(resetAt: number, windowSeconds: number): number {
  const now = Date.now() / 1000;
  const startedAt = resetAt - windowSeconds;
  return Math.max(0, Math.min(1, (now - startedAt) / windowSeconds));
}

// Warning state from this helper is always merged with `upgradePaths` and
// `unifiedRateLimitFallbackAvailable` by the caller, so we deliberately omit
// those fields here to avoid setting defaults that would be silently overridden.
type WarningRateLimitState = Omit<
  ClaudeRateLimitState,
  "upgradePaths" | "unifiedRateLimitFallbackAvailable"
>;

function getWarningRateLimitState(
  headers: Record<string, string>,
): WarningRateLimitState | null {
  for (const { claimAbbrev, rateLimitType } of SURPASSED_THRESHOLD_CLAIMS) {
    const surpassedThreshold = getHeader(
      headers,
      `anthropic-ratelimit-unified-${claimAbbrev}-surpassed-threshold`,
    );
    if (surpassedThreshold === undefined) continue;

    return {
      status: "allowed_warning",
      rateLimitType,
      resetsAt: parseNumberHeader(
        headers,
        `anthropic-ratelimit-unified-${claimAbbrev}-reset`,
      ),
      utilization: parseNumberHeader(
        headers,
        `anthropic-ratelimit-unified-${claimAbbrev}-utilization`,
      ),
      isUsingOverage: false,
    };
  }

  for (const config of RATE_LIMIT_WARNING_CONFIG) {
    const utilization = parseNumberHeader(
      headers,
      `anthropic-ratelimit-unified-${config.claimAbbrev}-utilization`,
    );
    const resetsAt = parseNumberHeader(
      headers,
      `anthropic-ratelimit-unified-${config.claimAbbrev}-reset`,
    );
    if (utilization === undefined || resetsAt === undefined) continue;

    const progress = getResetProgress(resetsAt, config.windowSeconds);
    const shouldWarn = config.thresholds.some(
      (threshold) =>
        utilization >= threshold.utilization && progress <= threshold.timePct,
    );
    if (!shouldWarn) continue;

    return {
      status: "allowed_warning",
      rateLimitType: config.rateLimitType,
      resetsAt,
      utilization,
      isUsingOverage: false,
    };
  }

  return null;
}

function parseUpgradePaths(
  headers: Record<string, string>,
): string[] | undefined {
  const value = getHeader(headers, "anthropic-ratelimit-unified-upgrade-paths");
  if (!value) return undefined;

  const paths = value
    .split(",")
    .map((path) => path.trim())
    .filter((path) => path.length > 0);
  return paths.length > 0 ? paths : undefined;
}

function resolveRateLimitStatus(
  headers: Record<string, string>,
  httpStatus?: number,
): ClaudeRateLimitStatus {
  const statusHeader = getHeader(headers, "anthropic-ratelimit-unified-status");
  if (isClaudeRateLimitStatus(statusHeader)) return statusHeader;

  const hasRepresentativeClaim =
    getHeader(headers, "anthropic-ratelimit-unified-representative-claim") !==
    undefined;
  const hasOverageStatus =
    getHeader(headers, "anthropic-ratelimit-unified-overage-status") !==
    undefined;
  // Match Claude Code's `rl_` fallback in decoded/2490.js: a 429 with rate-limit
  // representative-claim or overage headers is treated as `rejected`. We pin to
  // exactly 429 because 5xx errors don't carry these headers and we don't want
  // the rate-limit footer to fire on unrelated server failures.
  if (httpStatus === 429 && (hasRepresentativeClaim || hasOverageStatus))
    return "rejected";

  return "allowed";
}

function isGraceWindowActive(headers: Record<string, string>): boolean {
  return (
    getHeader(headers, "anthropic-ratelimit-unified-grace-status") !==
      undefined &&
    Math.max(
      parseNumberHeader(
        headers,
        "anthropic-ratelimit-unified-grace-5h-utilization",
      ) ?? 0,
      parseNumberHeader(
        headers,
        "anthropic-ratelimit-unified-grace-7d-utilization",
      ) ?? 0,
    ) > 0
  );
}

function parseClaudeRateLimitState(
  headers: Record<string, string>,
  httpStatus?: number,
): ClaudeRateLimitState | null {
  if (!hasUnifiedRateLimitHeaders(headers)) return null;

  const status = resolveRateLimitStatus(headers, httpStatus);
  const rateLimitTypeHeader = getHeader(
    headers,
    "anthropic-ratelimit-unified-representative-claim",
  );
  const rateLimitType = isClaudeRateLimitType(rateLimitTypeHeader)
    ? rateLimitTypeHeader
    : undefined;
  const overageStatusHeader = getHeader(
    headers,
    "anthropic-ratelimit-unified-overage-status",
  );
  const overageStatus = isClaudeOverageStatus(overageStatusHeader)
    ? overageStatusHeader
    : undefined;
  const overageResetsAt = parseNumberHeader(
    headers,
    "anthropic-ratelimit-unified-overage-reset",
  );
  const overageDisabledReason = getHeader(
    headers,
    "anthropic-ratelimit-unified-overage-disabled-reason",
  );
  const overageInUse =
    getHeader(headers, "anthropic-ratelimit-unified-overage-in-use") === "true";
  const overageUtilization = parseNumberHeader(
    headers,
    "anthropic-ratelimit-unified-overage-utilization",
  );
  const overageSurpassedThreshold = parseNumberHeader(
    headers,
    "anthropic-ratelimit-unified-overage-surpassed-threshold",
  );
  const overagePeriodMonthlyUtilization = parseNumberHeader(
    headers,
    "anthropic-ratelimit-unified-overage-period-monthly-utilization",
  );
  const overagePeriodChannelUtilization = parseNumberHeader(
    headers,
    "anthropic-ratelimit-unified-overage-period-channel-utilization",
  );
  const rateLimitGraceActive = isGraceWindowActive(headers);
  const upgradePaths = parseUpgradePaths(headers);
  const unifiedRateLimitFallbackAvailable =
    getHeader(headers, "anthropic-ratelimit-unified-fallback") === "available";

  if (status !== "rejected") {
    const warningState = getWarningRateLimitState(headers);
    if (warningState) {
      return {
        ...warningState,
        upgradePaths,
        unifiedRateLimitFallbackAvailable,
        overageInUse,
        overageUtilization,
        overageSurpassedThreshold,
        overagePeriodMonthlyUtilization,
        overagePeriodChannelUtilization,
        rateLimitGraceActive,
      };
    }
  }

  return {
    status,
    rateLimitType,
    resetsAt: parseNumberHeader(headers, "anthropic-ratelimit-unified-reset"),
    overageStatus,
    overageResetsAt,
    overageDisabledReason,
    overageInUse,
    overageUtilization,
    overageSurpassedThreshold,
    overagePeriodMonthlyUtilization,
    overagePeriodChannelUtilization,
    rateLimitGraceActive,
    upgradePaths,
    unifiedRateLimitFallbackAvailable,
    isUsingOverage:
      status === "rejected" &&
      (overageStatus === "allowed" || overageStatus === "allowed_warning"),
  };
}

function formatResetTime(resetAt: number): string {
  const resetDate = new Date(resetAt * 1000);
  const now = new Date();
  const minutes = resetDate.getMinutes();
  const timeZoneSuffix = ` (${Intl.DateTimeFormat().resolvedOptions().timeZone})`;

  if ((resetDate.getTime() - now.getTime()) / 3_600_000 > 24) {
    const options: Intl.DateTimeFormatOptions = {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: minutes === 0 ? undefined : "2-digit",
      hour12: true,
    };
    if (resetDate.getFullYear() !== now.getFullYear()) options.year = "numeric";
    return `${resetDate.toLocaleString("en-US", options).replace(/ ([AP]M)/i, (_match, meridiem: string) => meridiem.toLowerCase())}${timeZoneSuffix}`;
  }

  return `${resetDate
    .toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: minutes === 0 ? undefined : "2-digit",
      hour12: true,
    })
    .replace(/ ([AP]M)/i, (_match, meridiem: string) =>
      meridiem.toLowerCase(),
    )}${timeZoneSuffix}`;
}

function getRateLimitLabel(
  rateLimitType: ClaudeRateLimitType | undefined,
): string | null {
  if (rateLimitType === undefined) return null;
  if (rateLimitType === "seven_day_sonnet") {
    const subscriptionType = getClaudeSubscriptionType();
    return subscriptionType === "pro" || subscriptionType === "enterprise"
      ? "weekly limit"
      : "Sonnet limit";
  }
  return {
    five_hour: "session limit",
    seven_day: "weekly limit",
    seven_day_opus: "Opus limit",
    seven_day_overage_included: "Fable 5 limit",
    overage: "usage credit limit",
  }[rateLimitType];
}

function resetSuffix(resetAt: number | undefined): string {
  return resetAt ? ` · resets ${formatResetTime(resetAt)}` : "";
}

function formatRejectedRateLimitMessage(state: ClaudeRateLimitState): string {
  if (state.overageStatus !== "rejected") {
    return `You've hit your ${getRateLimitLabel(state.rateLimitType) ?? "usage limit"}${resetSuffix(state.resetsAt)}`;
  }
  const resets = [state.resetsAt, state.overageResetsAt].filter(
    (value): value is number => Boolean(value),
  );
  const suffix = resets.length > 0 ? resetSuffix(Math.min(...resets)) : "";
  return (
    new Map([
      ["out_of_credits", `You're out of usage credits${suffix}`],
      ["org_spend_cap_reached", `Your org is out of usage${suffix}`],
      [
        "seat_tier_level_disabled",
        "Your seat type doesn't include usage credits",
      ],
      [
        "seat_tier_zero_credit_limit",
        "Your seat type doesn't include usage credits",
      ],
      ["org_service_level_disabled", "This service is disabled for your org"],
      [
        "member_level_disabled",
        "Your usage allocation has been disabled by your admin",
      ],
      [
        "member_zero_credit_limit",
        "Your usage allocation has been disabled by your admin",
      ],
      ["group_zero_credit_limit", "Your group's usage limit is set to $0"],
      [
        "org_level_disabled_until",
        `Your org's monthly usage limit has been reached${suffix}`,
      ],
    ]).get(state.overageDisabledReason ?? "") ??
    `You've hit your usage limit${suffix}`
  );
}

function getWarningFooterStatus(
  state: ClaudeRateLimitState,
): ClaudeFooterStatus | null {
  const label = getRateLimitLabel(state.rateLimitType);
  if (!label) return null;
  if (state.utilization !== undefined && state.utilization < 0.7) return null;
  const prefix =
    state.utilization === undefined
      ? `Approaching ${label}`
      : `You've used ${Math.floor(state.utilization * 100)}% of your ${label}`;
  return {
    message: `${prefix}${resetSuffix(state.resetsAt)}`,
    severity: "warning",
  };
}

export function getClaudeFooterStatus(
  headers: Record<string, string>,
  httpStatus?: number,
): ClaudeFooterStatus | null {
  const state = parseClaudeRateLimitState(headers, httpStatus);
  if (!state) return null;

  if (state.status === "rejected" && !state.isUsingOverage) {
    return {
      message: formatRejectedRateLimitMessage(state),
      severity: "error",
    };
  }

  if (state.rateLimitGraceActive) {
    return {
      message:
        "Usage limit reached — grace window active. Wrap up or checkpoint soon.",
      severity: "warning",
    };
  }

  if (state.isUsingOverage) {
    if (state.overageStatus === "allowed_warning") {
      return {
        message: "You're close to your usage credit limit",
        severity: "warning",
      };
    }
    return null;
  }

  if (state.status === "allowed_warning") {
    return getWarningFooterStatus(state);
  }

  return null;
}

function getUnifiedRateLimitHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter(([key]) =>
      key.toLowerCase().startsWith("anthropic-ratelimit-unified-"),
    ),
  );
}

function isAnthropicOAuthToken(apiKey: string | undefined): apiKey is string {
  return typeof apiKey === "string" && apiKey.includes("sk-ant-oat");
}

function isAnthropicRateLimitError(message: string | undefined): boolean {
  if (!message) return false;
  return /(^|\b)429(\b|$)|rate_limit_error|too many requests|rate limit/i.test(
    message,
  );
}

function getQuotaCheckUrl(baseUrl: string | undefined): string {
  const normalizedBaseUrl = (baseUrl ?? "https://api.anthropic.com").replace(
    /\/+$/,
    "",
  );
  if (normalizedBaseUrl.endsWith("/v1/messages")) return normalizedBaseUrl;
  if (normalizedBaseUrl.endsWith("/v1")) return `${normalizedBaseUrl}/messages`;
  return `${normalizedBaseUrl}/v1/messages`;
}

function getOAuthUsageUrl(baseUrl: string | undefined): string | null {
  if (!isFirstPartyAnthropicBaseUrl(baseUrl)) return null;
  return "https://api.anthropic.com/api/oauth/usage";
}

function parseUsageReset(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.round(timestamp / 1000) : undefined;
}

function getUsageLimit(
  value: unknown,
): { utilization: number; resetsAt?: number; locked: boolean } | null {
  if (
    !isObject(value) ||
    typeof value.utilization !== "number" ||
    !Number.isFinite(value.utilization)
  )
    return null;
  return {
    utilization: value.utilization / 100,
    resetsAt: parseUsageReset(value.resets_at),
    locked:
      typeof value.locked_reason === "string" && value.locked_reason.length > 0,
  };
}

type UsageLimitCandidate = {
  type: ClaudeRateLimitType;
  value: { utilization: number; resetsAt?: number; locked: boolean };
};

export function usageResponseToRateLimitHeaders(
  value: unknown,
): Record<string, string> | null {
  if (!isObject(value)) return null;
  const candidates: Array<{
    type: ClaudeRateLimitType;
    value: { utilization: number; resetsAt?: number; locked: boolean } | null;
  }> = [
    { type: "five_hour", value: getUsageLimit(value.five_hour) },
    { type: "seven_day", value: getUsageLimit(value.seven_day) },
    { type: "seven_day_opus", value: getUsageLimit(value.seven_day_opus) },
    { type: "seven_day_sonnet", value: getUsageLimit(value.seven_day_sonnet) },
  ];
  const representative = candidates
    .filter(
      (candidate): candidate is UsageLimitCandidate =>
        candidate.value !== null &&
        (candidate.value.utilization >= 1 || candidate.value.locked),
    )
    .sort((a, b) => b.value.utilization - a.value.utilization)[0];
  // `extra_usage.disabled_reason` is set on every account that never enabled extra usage
  // (`is_enabled: false`, `used_credits: 0`). It describes the *fallback* pool, so on its
  // own it says nothing about whether the subscription limits are exhausted: only report a
  // rejection when a primary limit is actually spent or locked.
  if (!representative) return null;

  const extraUsage = value.extra_usage;

  const result: Record<string, string> = {
    "anthropic-ratelimit-unified-status": "rejected",
    "anthropic-ratelimit-unified-representative-claim": representative.type,
  };
  if (representative.value.resetsAt !== undefined) {
    result["anthropic-ratelimit-unified-reset"] = String(
      representative.value.resetsAt,
    );
  }
  if (
    isObject(extraUsage) &&
    extraUsage.is_enabled !== true &&
    typeof extraUsage.disabled_reason === "string" &&
    extraUsage.disabled_reason
  ) {
    result["anthropic-ratelimit-unified-overage-status"] = "rejected";
    result["anthropic-ratelimit-unified-overage-disabled-reason"] =
      extraUsage.disabled_reason;
  }
  return result;
}

async function fetchQuotaCheckHeaders(
  apiKey: string,
  baseUrl: string | undefined,
  headers: ProviderHeaders | undefined,
): Promise<{ headers: Record<string, string>; status: number } | null> {
  const usageUrl = getOAuthUsageUrl(baseUrl);
  const nonNullHeaders = Object.fromEntries(
    Object.entries(withClaudeCodeHeaders({ headers })?.headers ?? {}).filter(
      (entry): entry is [string, string] => entry[1] !== null,
    ),
  );
  const sharedHeaders = {
    ...nonNullHeaders,
    accept: "application/json",
    authorization: `Bearer ${apiKey}`,
    "content-type": "application/json",
    "anthropic-version": "2023-06-01",
    "anthropic-dangerous-direct-browser-access": "true",
    "anthropic-beta": "oauth-2025-04-20",
  };

  if (usageUrl) {
    const usageResponse = await fetch(usageUrl, {
      method: "GET",
      headers: sharedHeaders,
    });
    const usageHeaders = Object.fromEntries(usageResponse.headers.entries());
    if (hasUnifiedRateLimitHeaders(usageHeaders)) {
      return { headers: usageHeaders, status: usageResponse.status };
    }
    if (usageResponse.ok) {
      const usageBody: unknown = await usageResponse.json();
      const synthesizedHeaders = usageResponseToRateLimitHeaders(usageBody);
      if (synthesizedHeaders)
        return { headers: synthesizedHeaders, status: 429 };
    }
  }

  const response = await fetch(getQuotaCheckUrl(baseUrl), {
    method: "POST",
    headers: {
      ...sharedHeaders,
      "x-anthropic-billing-header": buildBillingHeader(
        [{ role: "user", content: "quota" }],
        getEntrypoint(),
        isFirstPartyAnthropicBaseUrl(baseUrl),
      ),
    },
    body: JSON.stringify({
      model: QUOTA_CHECK_MODEL,
      max_tokens: 1,
      messages: [{ role: "user", content: "quota" }],
    }),
  });

  return {
    headers: Object.fromEntries(response.headers.entries()),
    status: response.status,
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function resolveAnthropicQuotaFooterStatus(
  model: Model<"anthropic-messages">,
  options: SimpleStreamOptions = {},
): Promise<ClaudeFooterStatus | null> {
  const apiKey = options.apiKey;
  if (!isAnthropicOAuthToken(apiKey)) return null;

  const keyHash = sha256Hex(apiKey);
  if (
    cachedQuotaFooterStatus &&
    cachedQuotaFooterStatus.keyHash === keyHash &&
    Date.now() - cachedQuotaFooterStatus.checkedAt < QUOTA_CHECK_CACHE_TTL_MS
  ) {
    return cachedQuotaFooterStatus.value;
  }

  try {
    const quotaCheck = await fetchQuotaCheckHeaders(
      apiKey,
      model.baseUrl,
      options.headers,
    );
    if (!quotaCheck) return null;
    const footerStatus = getClaudeFooterStatus(
      quotaCheck.headers,
      quotaCheck.status,
    );
    cachedQuotaFooterStatus = {
      keyHash,
      value: footerStatus,
      checkedAt: Date.now(),
    };
    return footerStatus;
  } catch (error) {
    log("quota_check_failed", {
      message: errorText(error),
    });
    return null;
  }
}

function createAnthropicErrorEvent(
  model: Model<"anthropic-messages">,
  message: string,
): AssistantMessageEvent {
  return {
    type: "error",
    reason: "error",
    error: {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "error",
      errorMessage: message,
      timestamp: Date.now(),
    },
  };
}

function applyFooterStatusToCurrentContext(
  footerStatus: ClaudeFooterStatus,
): void {
  if (!latestCtx || !shouldApply(latestCtx)) return;

  setAdapterStatus(latestCtx, {
    phase: "warning",
    applies: true,
    suppressWarning: true,
    docsSource: adapterStatus.docsSource,
    billingHeader: adapterStatus.billingHeader,
    reason: "Resolved Claude usage state from Anthropic quota check",
    statusText: footerStatus.message,
  });
}

function getLogFile(): string | null {
  const path = process.env.PI_CLAUDE_OAUTH_LOG_FILE;
  return path ? resolve(path) : null;
}

function log(event: string, details: Record<string, unknown>): void {
  const logFile = getLogFile();
  if (!logFile) return;

  try {
    mkdirSync(dirname(logFile), { recursive: true });
    appendFileSync(
      logFile,
      `${JSON.stringify({ timestamp: new Date().toISOString(), event, ...details })}\n`,
      "utf8",
    );
  } catch {
    // Never let optional debug logging break the session.
  }
}

function shouldApply(ctx: ExtensionContext): boolean {
  const model = ctx.model;
  return (
    !!model &&
    model.provider === "anthropic" &&
    ctx.modelRegistry.isUsingOAuth(model)
  );
}

function clearAdapterStatuses(ctx: ExtensionContext): void {
  ctx.ui.setStatus(READY_STATUS_KEY, undefined);
  ctx.ui.setStatus(ISSUE_STATUS_KEY, undefined);
}

function renderAdapterStatus(ctx: ExtensionContext): void {
  clearAdapterStatuses(ctx);

  if (!adapterStatus.applies) return;

  const appearance = {
    inactive: null,
    ready: [READY_STATUS_KEY, "success", "✓ Claude OAuth ready"],
    active: [READY_STATUS_KEY, "success", "✓ Claude OAuth active"],
    warning: [ISSUE_STATUS_KEY, "warning", "Claude usage limit"],
    issue: [ISSUE_STATUS_KEY, "warning", "⚠ Claude OAuth setup"],
  } as const;
  const selected = appearance[adapterStatus.phase];
  if (!selected) return;
  ctx.ui.setStatus(
    selected[0],
    ctx.ui.theme.fg(selected[1], adapterStatus.statusText || selected[2]),
  );
}

function setAdapterStatus(
  ctx: ExtensionContext,
  nextStatus: AdapterStatusState,
): void {
  adapterStatus = nextStatus;
  renderAdapterStatus(ctx);
}

function shouldInjectDocs(prompt: string): boolean {
  const scope = getEnvScope();
  if (scope === "never") return false;
  if (scope === "always") return true;
  return PI_TOPIC_REGEX.test(prompt);
}

function extractDocsSection(
  systemPrompt: string,
): { docsSection: string; strippedPrompt: string } | null {
  const start = systemPrompt.indexOf(DOCS_OPEN + DOCS_MARKER);
  const end = systemPrompt.indexOf(DOCS_CLOSE, start);
  if (start < 0 || end < 0) return null;

  const docsSection = systemPrompt.slice(start + DOCS_OPEN.length, end).trim();
  const before = systemPrompt.slice(0, start).trimEnd();
  const after = systemPrompt.slice(end + DOCS_CLOSE.length).trimStart();
  const strippedPrompt = [before, after]
    .filter((part) => part.length > 0)
    .join("\n\n")
    .trim();
  return { docsSection, strippedPrompt };
}

function getPiPackageRoot(): string | null {
  const cliPath = process.argv[1];
  if (!cliPath) return null;

  try {
    const resolvedCliPath = realpathSync(cliPath);
    return dirname(dirname(resolvedCliPath));
  } catch {
    return null;
  }
}

function buildDynamicFallbackDocsSection(): string | null {
  const piRoot = getPiPackageRoot();
  if (!piRoot) return null;

  const readmePath = join(piRoot, "README.md");
  const docsPath = join(piRoot, "docs");
  const examplesPath = join(piRoot, "examples");
  return [
    DOCS_MARKER,
    `- Main documentation: ${readmePath}`,
    `- Additional docs: ${docsPath}`,
    `- Examples: ${examplesPath} (extensions, custom tools, SDK)`,
    "- When asked about: extensions (docs/extensions.md, examples/extensions/), themes (docs/themes.md), skills (docs/skills.md), prompt templates (docs/prompt-templates.md), TUI components (docs/tui.md), keybindings (docs/keybindings.md), SDK integrations (docs/sdk.md), custom providers (docs/custom-provider.md), adding models (docs/models.md), pi packages (docs/packages.md)",
    "- When working on pi topics, read the docs and examples, and follow .md cross-references before implementing",
    "- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)",
  ].join("\n");
}

function readFallbackDocsSection(): string | null {
  const override = process.env.PI_CLAUDE_OAUTH_DOCS_FILE;
  if (override) {
    const path = resolve(override);
    if (existsSync(path)) {
      const content = readFileSync(path, "utf8").trim();
      if (content.length > 0) return content;
    }
  }

  return buildDynamicFallbackDocsSection();
}

function resolveDocsSection(systemPrompt: string): ResolvedDocsSection {
  const extracted = extractDocsSection(systemPrompt);
  if (extracted) {
    return {
      extracted,
      docsSection: extracted.docsSection,
      docsSource: "system",
    };
  }

  const fallbackDocs = readFallbackDocsSection();
  if (fallbackDocs) {
    return {
      extracted: null,
      docsSection: fallbackDocs,
      docsSource: "fallback",
    };
  }

  return { extracted: null, docsSection: null, docsSource: "missing" };
}

function syncSetupStatus(
  ctx: ExtensionContext,
  systemPrompt: string,
): ResolvedDocsSection {
  latestCtx = ctx;

  if (!shouldApply(ctx)) {
    setAdapterStatus(ctx, {
      phase: "inactive",
      applies: false,
      suppressWarning: false,
      docsSource: "missing",
      billingHeader: "unknown",
      reason: "Not using Anthropic OAuth",
      statusText: "",
    });
    return { extracted: null, docsSection: null, docsSource: "missing" };
  }

  const resolved = resolveDocsSection(systemPrompt);
  if (!resolved.docsSection) {
    setAdapterStatus(ctx, {
      phase: "issue",
      applies: true,
      suppressWarning: false,
      docsSource: resolved.docsSource,
      billingHeader: "unknown",
      reason:
        "No Pi docs context available to rehydrate Anthropic OAuth requests",
      statusText: "⚠ Claude OAuth setup",
    });
    return resolved;
  }

  const nextPhase: AdapterPhase =
    adapterStatus.phase === "active" ? "active" : "ready";
  const nextReason =
    resolved.docsSource === "system"
      ? "Using system prompt docs context"
      : "Using fallback docs context";

  setAdapterStatus(ctx, {
    phase: nextPhase,
    applies: true,
    suppressWarning: true,
    docsSource: resolved.docsSource,
    billingHeader: adapterStatus.billingHeader,
    reason: nextReason,
    statusText:
      nextPhase === "ready" ? "✓ Claude OAuth ready" : adapterStatus.statusText,
  });

  return resolved;
}

function cloneBlock(block: TextBlock): TextBlock {
  return block.cache_control
    ? { ...block, cache_control: { ...block.cache_control } }
    : { ...block };
}

function ensurePromptBlock(
  blocks: TextBlock[],
  ctx: ExtensionContext,
): TextBlock[] {
  if (
    blocks.some(
      (block) => !block.text.startsWith("x-anthropic-billing-header:"),
    )
  ) {
    return blocks;
  }

  const systemPrompt = ctx.getSystemPrompt();
  const extracted = extractDocsSection(systemPrompt);
  const text = extracted?.strippedPrompt ?? systemPrompt;
  if (!text.trim()) return blocks;

  const template = blocks.find((block) => block.cache_control)?.cache_control;
  return [
    ...blocks,
    template
      ? { type: "text", text, cache_control: { ...template } }
      : { type: "text", text },
  ];
}

function normalizeSystemBlocks(
  blocks: TextBlock[],
  ctx: ExtensionContext,
  billingHeader: string,
): { blocks: TextBlock[]; billingState: BillingHeaderState } {
  let billingState: BillingHeaderState = "unknown";
  let sawBillingHeader = false;
  const nextBlocks: TextBlock[] = [];

  for (const block of blocks.filter((item) => item.text !== IDENTITY_BLOCK)) {
    if (block.text.startsWith("x-anthropic-billing-header:")) {
      if (sawBillingHeader) continue;
      sawBillingHeader = true;
      billingState = block.text === billingHeader ? "present" : "updated";
      nextBlocks.push({ ...cloneBlock(block), text: billingHeader });
      continue;
    }

    const extracted = extractDocsSection(block.text);
    if (extracted) {
      if (extracted.strippedPrompt.length > 0)
        nextBlocks.push({
          ...cloneBlock(block),
          text: extracted.strippedPrompt,
        });
    } else {
      nextBlocks.push(cloneBlock(block));
    }
  }

  if (!sawBillingHeader) {
    nextBlocks.unshift({ type: "text", text: billingHeader });
    billingState = "injected";
  }

  return { blocks: ensurePromptBlock(nextBlocks, ctx), billingState };
}

export default function claudeOauthAdapter(pi: ExtensionAPI) {
  pi.registerProvider("anthropic", {
    api: "anthropic-messages",
    streamSimple: (
      model: Model<Api>,
      context: Context,
      options?: SimpleStreamOptions,
    ) => {
      // A smaller configured window only schedules compaction; Pi's output clamp needs the real one.
      const anthropicModel = {
        ...model,
        contextWindow: CATALOG_WINDOWS.get(model.id) ?? model.contextWindow,
      } as Model<"anthropic-messages">;
      const transcript = normalizeContext(context);
      log("custom_stream_invoked", {
        model: anthropicModel.id,
        provider: anthropicModel.provider,
        isOAuth: isAnthropicOAuthToken(options?.apiKey),
      });
      if (!isAnthropicOAuthToken(options?.apiKey)) {
        return streamSimpleAnthropic(anthropicModel, transcript, options);
      }

      const outer = createAssistantMessageEventStream();

      void (async () => {
        try {
          const preflightFooterStatus = await resolveAnthropicQuotaFooterStatus(
            anthropicModel,
            options,
          );
          if (preflightFooterStatus) {
            applyFooterStatusToCurrentContext(preflightFooterStatus);
            if (preflightFooterStatus.severity === "error") {
              outer.push(
                createAnthropicErrorEvent(
                  anthropicModel,
                  preflightFooterStatus.message,
                ),
              );
              return;
            }
          }

          const inner = streamSimpleAnthropic(
            anthropicModel,
            transcript,
            withClaudeCodeHeaders(options),
          );
          for await (const event of inner) {
            if (
              event.type === "error" &&
              isAnthropicRateLimitError(event.error.errorMessage)
            ) {
              log("custom_stream_rate_limit", {
                message: event.error.errorMessage,
              });
              const footerStatus = await resolveAnthropicQuotaFooterStatus(
                anthropicModel,
                options,
              );
              if (footerStatus) {
                log("custom_stream_quota_resolved", {
                  message: footerStatus.message,
                  severity: footerStatus.severity,
                });
                applyFooterStatusToCurrentContext(footerStatus);
                outer.push(
                  createAnthropicErrorEvent(
                    anthropicModel,
                    footerStatus.message,
                  ),
                );
                continue;
              }
            }

            outer.push(event);
          }
          outer.end();
        } catch (error) {
          outer.push(
            createAnthropicErrorEvent(anthropicModel, errorText(error)),
          );
        }
      })();

      return outer;
    },
  });

  pi.on("session_start", (_event, ctx) => {
    syncSetupStatus(ctx, ctx.getSystemPrompt());
  });

  pi.on("model_select", (_event, ctx) => {
    syncSetupStatus(ctx, ctx.getSystemPrompt());
  });

  pi.on("before_agent_start", (event, ctx) => {
    latestCtx = ctx;
    const resolved = syncSetupStatus(ctx, event.systemPrompt);
    if (!shouldApply(ctx)) return;
    const inject =
      resolved.docsSection &&
      shouldInjectDocs(event.prompt) &&
      getEnvMode() !== "none";
    return {
      ...(resolved.extracted
        ? { systemPrompt: resolved.extracted.strippedPrompt }
        : {}),
      ...(inject
        ? {
            message: {
              customType: CUSTOM_TYPE,
              content: `<pi-docs-context>\n${resolved.docsSection}\n</pi-docs-context>`,
              display: false,
            },
          }
        : {}),
    };
  });

  pi.on("before_provider_request", (event, ctx) => {
    latestCtx = ctx;
    if (!shouldApply(ctx) || !isPayloadLike(event.payload)) return;

    const currentBlocks = Array.isArray(event.payload.system)
      ? event.payload.system.filter(isTextBlock)
      : [];
    const normalized = normalizeSystemBlocks(
      currentBlocks,
      ctx,
      buildBillingHeader(
        event.payload.messages,
        getEntrypoint(),
        isFirstPartyAnthropicBaseUrl(ctx.model?.baseUrl),
      ),
    );
    const reason = {
      injected: "Injected Claude billing header into Anthropic OAuth request",
      updated: "Updated Claude billing header",
      present: "Anthropic OAuth request already includes Claude billing header",
      unknown: "Normalized Anthropic OAuth request",
    }[normalized.billingState];

    setAdapterStatus(ctx, {
      phase: "active",
      applies: true,
      suppressWarning: true,
      docsSource:
        adapterStatus.docsSource === "missing"
          ? "fallback"
          : adapterStatus.docsSource,
      billingHeader: normalized.billingState,
      reason,
      statusText: "✓ Claude OAuth active",
    });

    return { ...event.payload, system: normalized.blocks };
  });

  pi.on("after_provider_response", (event, ctx) => {
    latestCtx = ctx;
    if (!shouldApply(ctx)) return;

    const footerStatus = getClaudeFooterStatus(event.headers, event.status);
    log("after_provider_response", {
      status: event.status,
      unifiedRateLimitHeaders: getUnifiedRateLimitHeaders(event.headers),
      footerStatus,
    });

    if (footerStatus) {
      setAdapterStatus(ctx, {
        phase: "warning",
        applies: true,
        suppressWarning: true,
        docsSource: adapterStatus.docsSource,
        billingHeader: adapterStatus.billingHeader,
        reason: `Anthropic OAuth request reported Claude usage state (${event.status})`,
        statusText: footerStatus.message,
      });
      return;
    }

    if (event.status >= 400) {
      setAdapterStatus(ctx, {
        phase: "issue",
        applies: true,
        suppressWarning: false,
        docsSource: adapterStatus.docsSource,
        billingHeader: adapterStatus.billingHeader,
        reason: `Anthropic OAuth request failed with HTTP ${event.status}`,
        statusText: "⚠ Claude OAuth setup",
      });
      return;
    }

    if (adapterStatus.phase === "active" || adapterStatus.phase === "warning") {
      setAdapterStatus(ctx, {
        ...adapterStatus,
        phase: "active",
        applies: true,
        suppressWarning: true,
        reason: `Anthropic OAuth request succeeded (${event.status})`,
        statusText: "✓ Claude OAuth active",
      });
    }
  });

  pi.on("session_shutdown", (_event, ctx) => {
    latestCtx = null;
    adapterStatus = {
      phase: "inactive",
      applies: false,
      suppressWarning: false,
      docsSource: "missing",
      billingHeader: "unknown",
      reason: "Session ended",
      statusText: "",
    };
    clearAdapterStatuses(ctx);
  });
}
