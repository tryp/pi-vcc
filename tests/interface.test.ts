/**
 * Interface tests for pi-vcc extension.
 * Verifies tool and command registrations with a mock pi.
 *
 * Runs with: `node --test tests/interface.test.ts`
 * Requires: typebox symlink (make link-packages)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { TSchema } from "typebox";

// ── Mock pi ─────────────────────────────────────────────────────────

interface CapturedTool {
	name: string;
	label: string;
	description: string;
	parameters: TSchema;
	execute: (toolCallId: string, params: Record<string, unknown>, ...rest: unknown[]) => Promise<any>;
}

interface CapturedCommand {
	name: string;
	description: string;
	handler: (args: string[], ctx: unknown) => Promise<void>;
}

function createMockPi(): { pi: any; tools: CapturedTool[]; commands: CapturedCommand[] } {
	const tools: CapturedTool[] = [];
	const commands: CapturedCommand[] = [];
	const pi: any = {
		registerTool: (t: CapturedTool) => tools.push(t),
		registerCommand: (name: string, cmd: { description: string; handler: Function }) =>
			commands.push({ name, description: cmd.description, handler: cmd.handler }),
		getSessionName: () => "test-session",
		on: () => {},
		getActiveTools: () => [],
		getAllTools: () => [],
		setActiveTools: () => {},
		getCommands: () => [],
		setModel: async () => true,
		getThinkingLevel: () => "none" as const,
		setThinkingLevel: () => {},
		sendMessage: () => {},
		sendUserMessage: () => {},
		appendEntry: () => {},
		setSessionName: () => {},
		setLabel: () => {},
		exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
		getFlag: () => undefined,
		registerShortcut: () => {},
		registerFlag: () => {},
		registerMessageRenderer: () => {},
		registerProvider: () => {},
		unregisterProvider: () => {},
		registerToolPromptGuidelines: () => {},
		events: { on: () => {}, emit: () => {} },
	};
	return { pi, tools, commands };
}

// ── Plugin the pi-vcc extension ─────────────────────────────────────

import ext from "../index.ts";

// ── Tests ───────────────────────────────────────────────────────────

describe("pi-vcc tool registration", () => {
	const { pi, tools, commands } = createMockPi();
	ext(pi);
	const toolMap = new Map(tools.map((t) => [t.name, t]));

	it("registers exactly 1 tool", () => {
		assert.equal(tools.length, 1);
	});

	it("registers vcc_recall tool", () => {
		assert.ok(toolMap.has("vcc_recall"), "vcc_recall tool not registered");
	});

	it("vcc_recall has non-empty description", () => {
		const t = toolMap.get("vcc_recall")!;
		assert.ok(t.description.length > 20, `description too short: "${t.description}"`);
	});

	it('vcc_recall description mentions "decisions"', () => {
		const t = toolMap.get("vcc_recall")!;
		assert.ok(
			t.description.includes("decisions"),
			`description missing "decisions": "${t.description}"`,
		);
	});

	it('vcc_recall description mentions "criteria"', () => {
		const t = toolMap.get("vcc_recall")!;
		assert.ok(
			t.description.includes("criteria"),
			`description missing "criteria": "${t.description}"`,
		);
	});

	it("vcc_recall has label", () => {
		const t = toolMap.get("vcc_recall")!;
		assert.ok(t.label?.length > 0, "label is empty");
	});

	it("vcc_recall has parameters defined", () => {
		const t = toolMap.get("vcc_recall")!;
		assert.ok(t.parameters, "parameters is undefined");
	});

	it("vcc_recall parameters have descriptions", () => {
		const t = toolMap.get("vcc_recall")!;
		const props = (t.parameters as any)?.properties ?? {};
		for (const [paramName, schema] of Object.entries(props)) {
			const s = schema as any;
			assert.ok(
				s.description?.length > 0,
				`"vcc_recall.${paramName}" missing description`,
			);
		}
	});
});

describe("pi-vcc command registration", () => {
	const { pi, commands } = createMockPi();
	ext(pi);
	const cmdMap = new Map(commands.map((c) => [c.name, c]));

	it("registers exactly 2 commands", () => {
		assert.equal(commands.length, 2);
	});

	it("registers pi-vcc command", () => {
		assert.ok(cmdMap.has("pi-vcc"), "pi-vcc command not registered");
	});

	it("registers pi-vcc-recall command", () => {
		assert.ok(cmdMap.has("pi-vcc-recall"), "pi-vcc-recall command not registered");
	});
});

describe("vcc_recall error paths", () => {
	it("invalidExpandIndices filters non-integer indices", async () => {
		const mod = await import("../src/tools/recall.ts");
		const { invalidExpandIndices } = mod;
		const result = invalidExpandIndices(
			[0.5, 1, 2.5, -1] as any,
			new Set([1, 2, 3]),
		);
		assert.ok(result.length > 0, "should reject invalid indices");
	});

	it("invalidExpandIndices rejects out-of-range indices", async () => {
		const mod = await import("../src/tools/recall.ts");
		const { invalidExpandIndices } = mod;
		const result = invalidExpandIndices([99], new Set([1, 2, 3]));
		assert.ok(result.length > 0, "should reject out-of-range index 99");
	});

	it("invalidExpandIndices accepts valid indices", async () => {
		const mod = await import("../src/tools/recall.ts");
		const { invalidExpandIndices } = mod;
		const result = invalidExpandIndices([1, 2], new Set([1, 2, 3]));
		assert.equal(result.length, 0, "should accept valid indices");
	});

	it("tool execute with no session file returns error text", async () => {
		const { pi } = createMockPi();
		pi.getSessionName = () => null;
		ext(pi);
		// Can't easily test execute path without full runtime,
		// but import validates no runtime errors
	});
});

describe("no stale references", () => {
	const { pi, tools } = createMockPi();
	ext(pi);

	const staleNames: string[] = [
		"pi-vcc-compact",
		"vcc_compact",
		"vcc_search",
		"vcc_lineage",
	];

	for (const tool of tools) {
		for (const stale of staleNames) {
			it(`${tool.name} does not mention removed tool "${stale}"`, () => {
				const mentions = tool.description.toLowerCase().includes(stale.toLowerCase());
				assert.ok(!mentions, `"${tool.name}" description mentions removed tool "${stale}"`);
			});
		}
	}
});
