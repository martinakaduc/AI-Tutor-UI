import { afterEach, describe, expect, it, vi } from "vitest";
import { env } from "$env/dynamic/private";
import superjson from "superjson";
import { collections } from "$lib/server/database";
import type { ConversationData } from "$lib/utils/pendingConversation";
import {
	cleanupTestData,
	createTestConversation,
	createTestLocals,
} from "./api/__tests__/testHelpers";
import { POST as report } from "../../routes/api/report-hallucination/+server";
import { POST as contact } from "../../routes/api/contact-ta/+server";
import { GET } from "../../routes/api/v2/conversations/[id]/+server";

afterEach(async () => {
	vi.unstubAllGlobals();
	await cleanupTestData();
});

const questionId = "11111111-1111-4111-8111-111111111111";
const messageId = "22222222-2222-4222-8222-222222222222";
const otherMessageId = "33333333-3333-4333-8333-333333333333";
const canvasUrl = "https://canvas.example/courses/97040/discussion_topics/42";
const text = { question: "Question from an earlier turn", answer: "Reported answer" };
const request = (body: unknown) =>
	new Request("http://localhost/api/feedback", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});

async function fixture() {
	const locals = createTestLocals();
	const conversation = await createTestConversation(locals, {
		rootMessageId: questionId,
		messages: [
			{ id: questionId, from: "user", content: text.question, children: [messageId] },
			{ id: messageId, from: "assistant", content: text.answer, ancestors: [questionId] },
			{
				id: otherMessageId,
				from: "assistant",
				content: "An alternative reply",
				ancestors: [questionId],
			},
		],
	});
	return {
		locals,
		conversation,
		body: { ...text, conversationId: conversation._id.toString(), messageId },
	};
}

describe("student feedback persistence", () => {
	it("forwards the question and answer and saves a successful report", async () => {
		const { locals, conversation, body } = await fixture();
		const fetch = vi.fn<typeof globalThis.fetch>(async () =>
			Response.json({ status: "ok", entry_id: 7 })
		);
		vi.stubGlobal("fetch", fetch);
		const res = await report({ locals, request: request(body) } as never);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ status: "ok", entry_id: 7 });
		expect(fetch.mock.calls[0][0]).toBe(`${env.OPENAI_BASE_URL}/chat/report-hallucination`);
		expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual(text);
		const stored = await collections.conversations.findOne({ _id: conversation._id });
		expect(stored?.studentFeedback).toEqual({ [messageId]: { hallucinationReported: true } });
	});

	it("restores both statuses and the Canvas link on reload, including after a message save", async () => {
		const { locals, conversation, body } = await fixture();
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input) =>
				Response.json(
					String(input).endsWith("/contact-ta")
						? { status: "success", url: canvasUrl }
						: { status: "ok", entry_id: 7 }
				)
			)
		);
		// Concurrent completions must merge independent fields rather than overwrite each other.
		const responses = await Promise.all([
			report({ locals, request: request(body) } as never),
			contact({ locals, request: request(body) } as never),
		]);
		expect(responses.map((res) => res.status)).toEqual([200, 200]);
		await collections.conversations.updateOne(
			{ _id: conversation._id },
			{
				$set: { messages: conversation.messages, updatedAt: new Date() },
			}
		);
		const res = await GET({
			locals,
			params: { id: conversation._id.toString() },
			url: new URL("http://localhost/api/v2/conversations/" + conversation._id),
		} as never);
		const reloaded = superjson.parse<ConversationData>(await res.text());
		expect(reloaded.studentFeedback).toEqual({
			[messageId]: { hallucinationReported: true, canvasPosted: true, canvasUrl },
		});
		expect(reloaded.studentFeedback?.[otherMessageId]).toBeUndefined();
	});

	it.each([report, contact])("does not resubmit an already saved action", async (handler) => {
		const { locals, conversation, body } = await fixture();
		await collections.conversations.updateOne(
			{ _id: conversation._id },
			{
				$set: {
					studentFeedback: {
						[messageId]: { hallucinationReported: true, canvasPosted: true, canvasUrl },
					},
				},
			}
		);
		const fetch = vi.fn();
		vi.stubGlobal("fetch", fetch);
		const res = await handler({ locals, request: request(body) } as never);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			status: "ok",
			...(handler === contact ? { url: canvasUrl } : {}),
		});
		expect(fetch).not.toHaveBeenCalled();
	});

	it.each([
		{ status: 502, body: { error: "Canvas refused the request." } },
		{ status: 200, body: { status: "error", error: "Posting failed." } },
		{ status: 200, body: { status: "pending" } },
	])("does not persist failed or incomplete requests: $body", async (upstream) => {
		const { locals, conversation, body } = await fixture();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json(upstream.body, { status: upstream.status }))
		);
		const res = await contact({ locals, request: request(body) } as never);
		expect(res.status).toBe(upstream.status);
		expect(await res.json()).toEqual(upstream.body);
		const stored = await collections.conversations.findOne({ _id: conversation._id });
		expect(stored?.studentFeedback).toBeUndefined();
	});

	it("rejects malformed text and IDs without contacting the backend", async () => {
		const { locals, body } = await fixture();
		const fetch = vi.fn();
		vi.stubGlobal("fetch", fetch);
		for (const invalid of [
			null,
			{},
			{ ...body, question: " " },
			{ ...body, question: 5 },
			{ ...body, conversationId: undefined },
			{ ...body, conversationId: "invalid" },
			{ ...body, messageId: undefined },
			{ ...body, messageId: "invalid.$key" },
		]) {
			expect((await contact({ locals, request: request(invalid) } as never)).status).toBe(400);
		}
		expect(
			(await report({ locals, request: request({ ...body, answer: undefined }) } as never)).status
		).toBe(400);
		expect(
			(
				await report({
					locals,
					request: new Request("http://localhost", { method: "POST", body: "{" }),
				} as never)
			).status
		).toBe(400);
		expect(fetch).not.toHaveBeenCalled();
	});

	it("requires the conversation owner and an existing assistant response", async () => {
		const { locals, body } = await fixture();
		const fetch = vi.fn();
		vi.stubGlobal("fetch", fetch);
		expect(
			(
				await contact({
					locals: createTestLocals({ sessionId: undefined }),
					request: request(body),
				} as never)
			).status
		).toBe(401);
		expect(
			(
				await contact({
					locals: createTestLocals({ sessionId: "different-student" }),
					request: request(body),
				} as never)
			).status
		).toBe(404);
		for (const id of [questionId, "44444444-4444-4444-8444-444444444444"]) {
			expect(
				(await report({ locals, request: request({ ...body, messageId: id }) } as never)).status
			).toBe(404);
		}
		expect(fetch).not.toHaveBeenCalled();
	});

	it("returns an error without saving a status when the backend is unreachable", async () => {
		const { locals, conversation, body } = await fixture();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new TypeError("private network details");
			})
		);
		const res = await contact({ locals, request: request(body) } as never);
		expect(res.status).toBe(502);
		expect((await res.json()).error).not.toContain("private network details");
		const stored = await collections.conversations.findOne({ _id: conversation._id });
		expect(stored?.studentFeedback).toBeUndefined();
	});
});
