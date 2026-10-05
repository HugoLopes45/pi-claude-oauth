import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  buildBillingHeader,
  getClaudeCodeVersion,
  getClaudeFooterStatus,
  usageResponseToRateLimitHeaders,
  withClaudeCodeHeaders,
} from "../extensions/index.ts";

function withFakeClaude<T>(output: string, run: () => T): T {
  const directory = mkdtempSync(join(tmpdir(), "pi-claude-oauth-adapter-"));
  const executable = join(directory, "claude");
  const originalPath = process.env.PATH;
  writeFileSync(executable, `#!/bin/sh\nprintf '%s\\n' '${output.replaceAll("'", "'\\''")}'\n`);
  chmodSync(executable, 0o755);
  process.env.PATH = `${directory}:${originalPath ?? ""}`;

  try {
    return run();
  } finally {
    process.env.PATH = originalPath;
    rmSync(directory, { recursive: true });
  }
}

const healthyUsage = {
  five_hour: { utilization: 20.0, resets_at: "2026-09-14T07:30:00.913859+00:00", locked_reason: null },
  seven_day: { utilization: 45.0, resets_at: "2026-09-15T14:00:00.913887+00:00", locked_reason: null },
  seven_day_opus: null,
  seven_day_sonnet: null,
  extra_usage: {
    is_enabled: false,
    monthly_limit: 2000,
    used_credits: 0.0,
    utilization: 0.0,
    disabled_reason: "out_of_credits",
    user_disabled: false,
    spend_limit_reached: false,
  },
};

describe("usageResponseToRateLimitHeaders", () => {
  it("does not reject a healthy account that simply never enabled extra usage", () => {
    expect(usageResponseToRateLimitHeaders(healthyUsage)).toBeNull();
  });

  it("rejects once a primary limit is spent, and reports the credit state", () => {
    const headers = usageResponseToRateLimitHeaders({
      ...healthyUsage,
      five_hour: { utilization: 100.0, resets_at: "2026-09-14T07:30:00.000000+00:00", locked_reason: null },
    });

    expect(headers).toEqual({
      "anthropic-ratelimit-unified-status": "rejected",
      "anthropic-ratelimit-unified-representative-claim": "five_hour",
      "anthropic-ratelimit-unified-reset": String(Date.parse("2026-09-14T07:30:00.000Z") / 1000),
      "anthropic-ratelimit-unified-overage-status": "rejected",
      "anthropic-ratelimit-unified-overage-disabled-reason": "out_of_credits",
    });
  });

  it("rejects a locked limit even below 100% utilization", () => {
    const headers = usageResponseToRateLimitHeaders({
      ...healthyUsage,
      seven_day: { utilization: 80.0, resets_at: null, locked_reason: "policy_violation" },
    });

    expect(headers?.["anthropic-ratelimit-unified-representative-claim"]).toBe("seven_day");
  });

  it("keeps enabled extra usage out of the rejection state", () => {
    const headers = usageResponseToRateLimitHeaders({
      ...healthyUsage,
      five_hour: { utilization: 100.0, resets_at: null, locked_reason: null },
      extra_usage: { is_enabled: true, disabled_reason: "out_of_credits" },
    });

    expect(headers?.["anthropic-ratelimit-unified-overage-status"]).toBeUndefined();
  });
});

describe("getClaudeFooterStatus", () => {
  it.each([
    ["out_of_credits", "You're out of usage credits"],
    ["org_spend_cap_reached", "Your org is out of usage"],
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
      "Your org's monthly usage limit has been reached",
    ],
    ["__proto__", "You've hit your usage limit"],
    ["constructor", "You've hit your usage limit"],
  ])("reports the rejected overage reason %s", (reason, message) => {
    expect(
      getClaudeFooterStatus({
        "anthropic-ratelimit-unified-status": "rejected",
        "anthropic-ratelimit-unified-overage-status": "rejected",
        "anthropic-ratelimit-unified-overage-disabled-reason": reason,
      }),
    ).toEqual({ message, severity: "error" });
  });

  it.each([
    ["0", "0", ""],
    ["1790258400", "1790262000", " · resets 2pm (UTC)"],
    ["1790262000", "1790258400", " · resets 2pm (UTC)"],
    ["0", "1790258400", " · resets 2pm (UTC)"],
    ["1790440200", "0", " · resets Sep 26, 4:30pm (UTC)"],
  ])(
    "selects the earliest available reset from %s and %s",
    (reset, overage, suffix) => {
      vi.stubEnv("TZ", "UTC");
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-09-24T12:00:00Z"));
      try {
        expect(
          getClaudeFooterStatus({
            "anthropic-ratelimit-unified-status": "rejected",
            "anthropic-ratelimit-unified-overage-status": "rejected",
            "anthropic-ratelimit-unified-overage-disabled-reason":
              "out_of_credits",
            "anthropic-ratelimit-unified-reset": reset,
            "anthropic-ratelimit-unified-overage-reset": overage,
          }),
        ).toEqual({
          message: `You're out of usage credits${suffix}`,
          severity: "error",
        });
      } finally {
        vi.useRealTimers();
        vi.unstubAllEnvs();
      }
    },
  );

  it.each([
    ["0.69", null],
    [
      "0.8",
      { message: "You've used 80% of your session limit", severity: "warning" },
    ],
  ])(
    "shows warnings only at the utilization threshold: %s",
    (utilization, expected) => {
      expect(
        getClaudeFooterStatus({
          "anthropic-ratelimit-unified-status": "allowed_warning",
          "anthropic-ratelimit-unified-5h-surpassed-threshold": "true",
          "anthropic-ratelimit-unified-5h-utilization": utilization,
        }),
      ).toEqual(expected);
    },
  );

  it("reports a grace window without treating it as a rejected request", () => {
    expect(
      getClaudeFooterStatus({
        "anthropic-ratelimit-unified-status": "allowed",
        "anthropic-ratelimit-unified-grace-status": "active",
        "anthropic-ratelimit-unified-grace-5h-utilization": "0.2",
      }),
    ).toEqual({
      message:
        "Usage limit reached — grace window active. Wrap up or checkpoint soon.",
      severity: "warning",
    });
  });

  it("stays silent on a live response that only advertises disabled extra usage", () => {
    expect(
      getClaudeFooterStatus(
        {
          "anthropic-ratelimit-unified-status": "allowed",
          "anthropic-ratelimit-unified-5h-status": "allowed",
          "anthropic-ratelimit-unified-5h-utilization": "0.19",
          "anthropic-ratelimit-unified-5h-reset": "1789371000",
          "anthropic-ratelimit-unified-representative-claim": "five_hour",
          "anthropic-ratelimit-unified-overage-status": "rejected",
          "anthropic-ratelimit-unified-overage-disabled-reason": "out_of_credits",
        },
        200,
      ),
    ).toBeNull();
  });

  it("reports an error once the request is actually rejected", () => {
    const status = getClaudeFooterStatus(
      {
        "anthropic-ratelimit-unified-status": "rejected",
        "anthropic-ratelimit-unified-representative-claim": "five_hour",
      },
      429,
    );

    expect(status?.severity).toBe("error");
    expect(status?.message).toContain("session limit");
  });
});

describe("claude code version handling", () => {
  it("reads the installed Claude Code version", () => {
    expect(withFakeClaude("9.8.7 (Claude Code)", () => getClaudeCodeVersion())).toBe("9.8.7");
  });

  it("rejects an unreadable local version", () => {
    expect(() => withFakeClaude("Claude Code development build", () => getClaudeCodeVersion())).toThrow(
      "Could not parse the local Claude Code version",
    );
  });

  it("replaces stale client identity headers", () => {
    const options = withFakeClaude("9.8.7 (Claude Code)", () =>
      withClaudeCodeHeaders({
        headers: {
          "User-Agent": "claude-cli/2.1.263",
          "x-app": "stale",
          "x-claude-code-session-id": "stale-session",
          "x-custom": "kept",
        },
        sessionId: "current-session",
      }),
    );

    expect(options?.headers).toEqual({
      "x-custom": "kept",
      "user-agent": "claude-cli/9.8.7 (external, pi)",
      "x-app": "cli",
      "x-claude-code-session-id": "current-session",
    });
  });
});

describe("buildBillingHeader", () => {
  it("uses the installed version and keeps Claude Code's field order", () => {
    expect(withFakeClaude("9.8.7 (Claude Code)", () => buildBillingHeader([{ role: "user", content: "hi" }], "pi", true))).toMatch(
      /^x-anthropic-billing-header: cc_version=9\.8\.7\.[0-9a-f]{3}; cc_entrypoint=pi; cch=00000;$/,
    );
  });

  it("omits cch for non first-party endpoints", () => {
    expect(buildBillingHeader([{ role: "user", content: "hi" }], "pi", false)).not.toContain("cch=");
  });
});
