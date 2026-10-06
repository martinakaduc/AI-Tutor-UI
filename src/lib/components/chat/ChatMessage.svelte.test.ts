import ChatMessage from "./ChatMessage.svelte";
import { render } from "vitest-browser-svelte";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { tick } from "svelte";
import { MessageUpdateType } from "$lib/types/MessageUpdate";
import { renderWithApp } from "../__tests__/renderWithApp";
import { error as chatError } from "$lib/stores/errors";
import { get } from "svelte/store";

beforeEach(() => {
	vi.stubGlobal("fetch", async () => new Response("{}", { status: 200 }));
	vi.stubGlobal(
		"confirm",
		vi.fn(() => true)
	);
});
afterEach(() => {
	vi.unstubAllGlobals();
	chatError.set(undefined);
});

const call = (uuid: string) => ({
	type: "tool",
	subtype: "call",
	uuid,
	call: { name: "ask_user_question", parameters: {} },
});
const result = (uuid: string) => ({
	type: "tool",
	subtype: "result",
	uuid,
	result: {
		status: 0,
		call: { name: "ask_user_question", parameters: {} },
		outputs: [{ text: "The user answered: S3" }],
		display: true,
	},
});
const answeredQuestion = [
	{
		type: "elicitation",
		subtype: "request",
		toolUuid: "u1",
		request: {
			elicitationId: "e1",
			source: "assistant",
			server: "",
			mode: "form",
			message: "",
			fields: [
				{
					kind: "select",
					name: "q1",
					title: "Storage",
					description: "Where should uploads go?",
					required: true,
					multiple: false,
					options: [{ value: "S3", label: "S3" }],
				},
			],
		},
	},
	{
		type: "elicitation",
		subtype: "resolved",
		elicitationId: "e1",
		action: "accept",
		resolution: "user",
		content: { q1: "S3" },
	},
];

const mount = (updates: unknown[], content = "") =>
	render(ChatMessage, {
		message: { id: "m1", from: "assistant", content, children: [], updates },
		loading: true,
		isLast: true,
		isAuthor: true,
		readOnly: false,
	} as never);

const spinners = (el: HTMLElement) => el.querySelectorAll(".loading").length;

describe("student feedback actions", () => {
	const completed = (extra = {}) =>
		renderWithApp(ChatMessage, {
			message: { id: "feedback-m1", from: "assistant", content: "[Admin] A reply.", children: [] },
			question: "Question from this turn",
			conversationId: "507f1f77bcf86cd799439011",
			loading: false,
			isLast: true,
			...extra,
		});

	const button = (container: HTMLElement, label: string) =>
		container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;

	it.each(["Report hallucination", "Contact TA"])(
		"sends no request when the student cancels %s",
		async (label) => {
			const confirm = vi.fn(() => false);
			const fetch = vi.fn();
			vi.stubGlobal("confirm", confirm);
			vi.stubGlobal("fetch", fetch);
			const { container } = completed();
			const action = button(container, label);
			action.click();
			await tick();
			expect(confirm).toHaveBeenCalledTimes(1);
			expect(fetch).not.toHaveBeenCalled();
			expect(action.disabled).toBe(false);
			expect(action.textContent?.trim()).toBe(label);
			expect(get(chatError)).toBeUndefined();
		}
	);

	it("places Report hallucination and Contact TA before Copy and Retry", async () => {
		const { container } = completed();
		const labels = Array.from(container.querySelectorAll("button")).map(
			(b) => b.getAttribute("aria-label") ?? b.title
		);
		expect(labels.indexOf("Report hallucination")).toBeLessThan(labels.indexOf("Contact TA"));
		expect(labels.indexOf("Contact TA")).toBeLessThan(labels.indexOf("Copy to clipboard"));
		expect(labels.indexOf("Copy to clipboard")).toBeLessThan(labels.indexOf("Retry"));
		await tick();
		const report = button(container, "Report hallucination").getBoundingClientRect();
		const contact = button(container, "Contact TA").getBoundingClientRect();
		const copy = container
			.querySelector<HTMLButtonElement>('button[title="Copy to clipboard"]')!
			.getBoundingClientRect();
		expect(report.right).toBeLessThanOrEqual(contact.left);
		expect(contact.right).toBeLessThanOrEqual(copy.left);
	});

	it("keeps the controls inside a narrow chat column for short answers", async () => {
		const { container } = completed();
		container.style.width = "320px";
		container.style.containerType = "inline-size";
		await vi.waitFor(() => {
			const bounds = container.getBoundingClientRect();
			const report = button(container, "Report hallucination").getBoundingClientRect();
			const retry = container
				.querySelector<HTMLButtonElement>('button[title="Retry"]')!
				.getBoundingClientRect();
			expect(report.left).toBeGreaterThanOrEqual(bounds.left);
			expect(retry.right).toBeLessThanOrEqual(bounds.right);
		});
	});

	it("reports the response's question and blocks duplicate clicks", async () => {
		let resolve!: (response: Response) => void;
		const fetch = vi.fn<typeof globalThis.fetch>(
			() =>
				new Promise((r) => {
					resolve = r;
				})
		);
		vi.stubGlobal("fetch", fetch);
		const { container } = completed();
		const report = button(container, "Report hallucination");
		report.click();
		report.click();
		await tick();
		expect(window.confirm).toHaveBeenCalledOnce();
		expect(window.confirm).toHaveBeenCalledWith(
			"Report this response as hallucinated? Your question and this response will be sent to the TA for review."
		);
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(fetch.mock.calls[0][0]).toBe("/api/report-hallucination");
		expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual({
			question: "Question from this turn",
			answer: "[Admin] A reply.",
			conversationId: "507f1f77bcf86cd799439011",
			messageId: "feedback-m1",
		});
		expect(report.disabled).toBe(true);
		resolve(Response.json({ status: "ok", entry_id: 1 }));
		await vi.waitFor(() => expect(report.textContent).toContain("Reported"));
		expect(report.disabled).toBe(true);
	});

	it("shows the Canvas post link after Contact TA succeeds", async () => {
		const url = "https://canvas.example/courses/97040/discussion_topics/42";
		const fetch = vi.fn<typeof globalThis.fetch>(async () =>
			Response.json({ status: "success", url })
		);
		vi.stubGlobal("fetch", fetch);
		const { container } = completed();
		button(container, "Contact TA").click();
		await vi.waitFor(() => expect(container.querySelector(`a[href="${url}"]`)).toBeTruthy());
		expect(window.confirm).toHaveBeenCalledWith(
			"Contact a TA? Your question will be posted to the course forum on Canvas."
		);
		expect(JSON.parse(String(fetch.mock.calls[0][1]?.body)).question).toBe(
			"Question from this turn"
		);
		expect(button(container, "Contact TA").disabled).toBe(true);
	});

	it("restores saved statuses and the Canvas post link when mounted again", () => {
		const fetch = vi.fn();
		vi.stubGlobal("fetch", fetch);
		const url = "https://canvas.example/courses/97040/discussion_topics/42";
		const { container } = completed({
			feedback: { hallucinationReported: true, canvasPosted: true, canvasUrl: url },
		});
		const report = button(container, "Report hallucination");
		const contact = button(container, "Contact TA");
		expect(report.textContent?.trim()).toBe("Reported");
		expect(contact.textContent?.trim()).toBe("Posted to Canvas");
		expect(report.disabled).toBe(true);
		expect(contact.disabled).toBe(true);
		expect(container.querySelector(`a[href="${url}"]`)?.textContent?.trim()).toBe("View post");
		report.click();
		contact.click();
		expect(window.confirm).not.toHaveBeenCalled();
		expect(fetch).not.toHaveBeenCalled();
	});

	it.each([
		{
			feedback: { hallucinationReported: true },
			disabled: "Report hallucination",
			enabled: "Contact TA",
		},
		{ feedback: { canvasPosted: true }, disabled: "Contact TA", enabled: "Report hallucination" },
	])("keeps the two saved statuses independent: $disabled", ({ feedback, disabled, enabled }) => {
		const { container } = completed({ feedback });
		expect(button(container, disabled).disabled).toBe(true);
		expect(button(container, enabled).disabled).toBe(false);
	});

	it("does not carry a completed action into another response", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ status: "ok" }))
		);
		const onfeedback = vi.fn();
		const screen = completed({ onfeedback });
		button(screen.container, "Report hallucination").click();
		await vi.waitFor(() =>
			expect(onfeedback).toHaveBeenCalledWith({
				conversationId: "507f1f77bcf86cd799439011",
				messageId: "feedback-m1",
				feedback: { hallucinationReported: true },
			})
		);
		expect(button(screen.container, "Report hallucination").disabled).toBe(true);
		await screen.rerender({
			message: { id: "feedback-m2", from: "assistant", content: "Another reply." },
		});
		expect(button(screen.container, "Report hallucination").disabled).toBe(false);
	});

	it("shows backend failures and lets the student try again", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ error: "Canvas refused the request." }, { status: 502 }))
		);
		const { container } = completed();
		button(container, "Contact TA").click();
		await vi.waitFor(() => expect(get(chatError)).toBe("Canvas refused the request."));
		expect(button(container, "Contact TA").disabled).toBe(false);
		expect(container.textContent).not.toContain("Posted to Canvas");
	});

	it("disables feedback when the question is unavailable", () => {
		const { container } = completed({ question: "" });
		expect(button(container, "Report hallucination").disabled).toBe(true);
		expect(button(container, "Contact TA").disabled).toBe(true);
	});

	it("hides feedback in shared conversations", () => {
		const { container } = completed({ isAuthor: false });
		expect(button(container, "Report hallucination")).toBeNull();
		expect(button(container, "Contact TA")).toBeNull();
	});
});

describe("a run still working with nothing streaming", () => {
	// One mount per test: they share a document, so a second would count the first's.
	it("says so after a question has been answered", () => {
		// The settled row is all there is while the call restarts, and it does not animate.
		expect(spinners(mount([call("u1"), ...answeredQuestion]).baseElement)).toBe(1);
	});

	it("says so while the model thinks after a tool has finished", () => {
		expect(spinners(mount([call("u1"), result("u1"), ...answeredQuestion]).baseElement)).toBe(1);
	});

	it("adds nothing while reasoning streams, which shows its own progress", () => {
		// An unclosed <think> is reasoning still arriving; it animates itself without this
		// class, so anything here would be ours doubling up.
		const { baseElement } = mount([], "<think>weighing the options");
		expect(spinners(baseElement)).toBe(0);
	});
});

describe("assistant message files", () => {
	it("renders the same content attached twice", () => {
		const file = { type: "hash", value: "a".repeat(64), mime: "text/plain", name: "metrics.txt" };
		const { baseElement } = render(ChatMessage, {
			message: {
				id: "m1",
				from: "assistant",
				content: "Done.",
				children: [],
				updates: [],
				files: [file, { ...file }],
			},
			loading: false,
			isLast: true,
			isAuthor: true,
			readOnly: false,
		} as never);

		const names = Array.from(baseElement.querySelectorAll("dd")).map((dd) =>
			dd.textContent?.trim()
		);
		expect(names).toEqual(["metrics.txt", "metrics.txt"]);
	});
});

describe("collapsed process blocks during streaming", () => {
	const stream = (token: string) => ({ type: "stream", token });
	const streamCall = (uuid: string) => ({
		type: "tool",
		subtype: "call",
		uuid,
		call: { name: "hf_fs", parameters: {} },
	});
	const streamResult = (uuid: string) => ({
		type: "tool",
		subtype: "result",
		uuid,
		result: {
			status: 0,
			call: { name: "hf_fs", parameters: {} },
			outputs: [{ text: "ok" }],
			display: true,
		},
	});
	const expanded = (el: HTMLElement) => el.querySelectorAll('button[aria-label="Collapse"]');

	it("never expands more than the active block, even after a lost think closer", async () => {
		// Round 1's reasoning never receives its </think> (the closer can get lost
		// when tool-call deltas mute the content stream server-side). That stale
		// block must not shimmer or re-expand each time a later block goes active.
		const steps = [
			stream("<think>Reading the repo"),
			streamCall("u1"),
			streamResult("u1"),
			stream("Let me dig into the README."),
			stream("<think>Checking metadata</think>"),
			streamCall("u2"),
			streamResult("u2"),
			stream("Grabbing the repo metadata too."),
			stream("<think>Final synthesis"),
		];

		const updates: unknown[] = [];
		const screen = mount([]);
		for (const step of steps) {
			updates.push(step);
			await screen.rerender({
				message: { id: "m1", from: "assistant", content: "", children: [], updates: [...updates] },
			} as never);
			await tick();
			expect(expanded(screen.baseElement as HTMLElement).length).toBeLessThanOrEqual(1);
		}

		// The active think block streams at the end; it alone is expanded.
		const open = expanded(screen.baseElement as HTMLElement);
		expect(open.length).toBe(1);
		expect(open[0].textContent).toContain("Thinking");
	});

	it("keeps the flat rows through mid-turn narration instead of regrouping them", async () => {
		// Models narrate between tool rounds. That text must not collapse the
		// previous rows into the "Called N tools" summary mid-turn: the next
		// round would explode the summary back into rows, which reads as the
		// collapsed blocks re-expanding. Grouping belongs to the finished turn.
		const steps = [
			streamCall("u1"),
			streamResult("u1"),
			streamCall("u2"),
			streamResult("u2"),
			stream("This is excellent research. Let me search more."),
			streamCall("u3"),
			streamResult("u3"),
			stream("Now I have comprehensive data."),
			streamCall("u4"),
		];
		const summaries = (el: HTMLElement) =>
			[...el.querySelectorAll("button")].filter((b) =>
				/^Called \d+ tools?/.test(b.textContent?.trim() ?? "")
			);
		const toolRows = (el: HTMLElement) => el.querySelectorAll("code").length;

		const updates: unknown[] = [];
		const screen = mount([]);
		let previousRows = 0;
		for (const step of steps) {
			updates.push(step);
			await screen.rerender({
				message: { id: "m1", from: "assistant", content: "", children: [], updates: [...updates] },
			} as never);
			await tick();
			const el = screen.baseElement as HTMLElement;
			expect(summaries(el).length).toBe(0);
			expect(toolRows(el)).toBeGreaterThanOrEqual(previousRows);
			previousRows = toolRows(el);
		}

		// Once the turn is over, the finished-turn grouping takes over.
		await screen.rerender({ loading: false } as never);
		await tick();
		expect(summaries(screen.baseElement as HTMLElement).length).toBeGreaterThan(0);
	});
});

describe("a finished turn stored in the rounds shape", () => {
	const args = '{"path":"/work","recursive":true}';
	const callUpdate = (parameters: Record<string, unknown>) => ({
		type: "tool",
		subtype: "call",
		uuid: "u1",
		call: { name: "hf_fs", parameters },
		argumentsRaw: args,
		reasoning: "I need the files.",
		content: "Let me look.",
	});
	const resultUpdate = {
		type: "tool",
		subtype: "result",
		uuid: "u1",
		result: { status: 0, call: { name: "hf_fs", parameters: {} }, outputs: [{ text: "ok" }] },
	};
	const round = "<think>I need the files.</think>Let me look.";
	const answer = "<think>All there.</think>Everything is in **/work**.";
	const legacy = {
		id: "m1",
		from: "assistant",
		content: round + answer,
		children: [],
		updates: [
			{ type: "stream", token: "", len: round.length },
			callUpdate({ path: "/work", recursive: true }),
			resultUpdate,
			{ type: "stream", token: "", len: answer.length },
			{ type: "finalAnswer", text: answer, interrupted: false },
		],
	};
	const rounds = {
		id: "m1",
		from: "assistant",
		content: "Everything is in **/work**.",
		reasoning: "All there.",
		contentShape: 2,
		children: [],
		updates: [
			callUpdate({}),
			resultUpdate,
			{ type: "finalAnswer", text: "", len: answer.length, interrupted: false },
		],
	};
	const show = (message: unknown) =>
		render(ChatMessage, { message, loading: false, isLast: false } as never).container;

	it("renders what its legacy form rendered", async () => {
		const fromLegacy = show(legacy);
		const fromRounds = show(rounds);
		await vi.waitFor(() => {
			expect(fromLegacy.querySelector("strong")?.textContent).toBe("/work");
			expect(fromRounds.querySelector("strong")?.textContent).toBe("/work");
		});

		expect(fromRounds.innerHTML).toBe(fromLegacy.innerHTML);
		expect(fromRounds.textContent?.match(/Let me look\./g)).toHaveLength(1);
	});

	it("copies every visible text, the round's preamble included", async () => {
		const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
		const copy = show(rounds).querySelector<HTMLButtonElement>("button[title='Copy to clipboard']");
		copy?.click();

		await vi.waitFor(() =>
			expect(writeText).toHaveBeenCalledWith("Let me look.Everything is in **/work**.")
		);
	});
});

describe("a notice on an assistant turn", () => {
	const text =
		"data.csv is too long to send whole: the model sees 150,000 of its 2,340,112 characters, from the start and the end.";
	const notice = { type: MessageUpdateType.Notice, text };
	const noticeWrapper = (el: HTMLElement) =>
		[...el.querySelectorAll("span")]
			.find((span) => span.textContent === text)
			?.closest("[data-exclude-from-copy]");

	it("shows with the answer and stays out of what is copied", async () => {
		const { container } = render(ChatMessage, {
			message: {
				id: "m1",
				from: "assistant",
				content: "Summary.",
				children: [],
				updates: [
					notice,
					{ type: MessageUpdateType.FinalAnswer, text: "Summary.", interrupted: false },
				],
			},
			loading: false,
			isLast: true,
		} as never);

		await vi.waitFor(() => expect(container.textContent).toContain("Summary."));
		expect(noticeWrapper(container)).toBeTruthy();
	});

	it("keeps the spinner while it is all that has arrived", () => {
		const { container } = mount([notice]);
		expect(noticeWrapper(container)).toBeTruthy();
		expect(spinners(container)).toBe(1);
	});
});
