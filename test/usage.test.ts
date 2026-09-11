// HAL-ID: #HAL-20260911-2129-NH-UT
// Description: Usage headers → structured usage, human line, warning thresholds
import { describe, expect, test } from "bun:test";
import { formatUsage, parseCodexUsage, usageThreshold } from "../src/usage";

const H = (extra: Record<string, string> = {}) =>
	new Headers({
		"x-codex-plan-type": "pro",
		"x-codex-active-limit": "premium",
		"x-codex-primary-used-percent": "2",
		"x-codex-primary-window-minutes": "10080",
		"x-codex-primary-reset-after-seconds": "384316",
		"x-codex-primary-reset-at": "1789448352",
		"x-codex-secondary-used-percent": "0",
		"x-codex-secondary-window-minutes": "0",
		"x-codex-secondary-reset-after-seconds": "0",
		"x-codex-credits-balance": "0",
		...extra,
	});

describe("usage", () => {
	test("parses the live header shape; a zero-minute secondary window means 'not in force'", () => {
		const u = parseCodexUsage(H(), 1000);
		expect(u).toEqual({
			plan: "pro",
			activeLimit: "premium",
			primary: {
				usedPercent: 2,
				windowMinutes: 10080,
				resetAfterSeconds: 384316,
				resetAt: 1789448352,
			},
			secondary: null,
			creditsBalance: 0,
			observedAt: 1000,
		});
	});
	test("no primary window header → null (Cloudflare error pages etc.)", () => {
		expect(parseCodexUsage(new Headers({ server: "cloudflare" }))).toBeNull();
	});
	test("a 5-hour secondary window is reported", () => {
		const u = parseCodexUsage(
			H({
				"x-codex-secondary-window-minutes": "300",
				"x-codex-secondary-used-percent": "40",
				"x-codex-secondary-reset-after-seconds": "7200",
			}),
		);
		expect(u?.secondary).toEqual({
			usedPercent: 40,
			windowMinutes: 300,
			resetAfterSeconds: 7200,
			resetAt: null,
		});
	});
	test("formatUsage is one human line", () => {
		const u = parseCodexUsage(H({ "x-codex-primary-used-percent": "37" }));
		expect(formatUsage(u as NonNullable<typeof u>)).toBe(
			"ChatGPT pro usage: 37% of the 1-week window (resets in 4d 10h)",
		);
	});
	test("thresholds: null <80, 80, 95 — worst window wins", () => {
		const at = (p: string, s = "0") =>
			usageThreshold(
				parseCodexUsage(
					H({
						"x-codex-primary-used-percent": p,
						"x-codex-secondary-window-minutes": "300",
						"x-codex-secondary-used-percent": s,
					}),
				) as never,
			);
		expect(at("79")).toBeNull();
		expect(at("80")).toBe(80);
		expect(at("10", "96")).toBe(95);
	});
});
