import { env } from "$env/dynamic/private";
import { json } from "@sveltejs/kit";
import { ObjectId } from "mongodb";
import { validate as isUUID } from "uuid";
import { authCondition } from "$lib/server/auth";
import { collections } from "$lib/server/database";

export async function forwardStudentFeedback(
	request: Request,
	action: "report-hallucination" | "contact-ta",
	locals: App.Locals
) {
	if (!locals.user?._id && !locals.sessionId) {
		return json({ error: "A valid session is required." }, { status: 401 });
	}
	let data: unknown;
	try {
		data = await request.json();
	} catch {
		return json({ error: "Invalid JSON request." }, { status: 400 });
	}
	if (
		!data ||
		typeof data !== "object" ||
		!("question" in data) ||
		typeof data.question !== "string" ||
		!data.question.trim() ||
		(action === "report-hallucination" &&
			(!("answer" in data) || typeof data.answer !== "string" || !data.answer.trim()))
	) {
		return json(
			{ error: "Question and, for a hallucination report, answer text are required." },
			{ status: 400 }
		);
	}
	if (
		!("conversationId" in data) ||
		typeof data.conversationId !== "string" ||
		!ObjectId.isValid(data.conversationId) ||
		!("messageId" in data) ||
		typeof data.messageId !== "string" ||
		!isUUID(data.messageId)
	) {
		return json({ error: "Valid conversation and response IDs are required." }, { status: 400 });
	}
	const filter = {
		_id: new ObjectId(data.conversationId),
		...authCondition(locals),
		messages: { $elemMatch: { id: data.messageId, from: "assistant" } },
	};
	const conversation = await collections.conversations.findOne(filter);
	if (!conversation) {
		return json({ error: "Conversation or response not found." }, { status: 404 });
	}
	const saved = conversation.studentFeedback?.[data.messageId];
	if (
		(action === "report-hallucination" && saved?.hallucinationReported) ||
		(action === "contact-ta" && saved?.canvasPosted)
	) {
		// A retry after a reload must not submit an already completed action again.
		return json({ status: "ok", ...(action === "contact-ta" ? { url: saved?.canvasUrl } : {}) });
	}
	const upstreamUrl = (env.OPENAI_BASE_URL || "http://127.0.0.1:8008/v1").replace(/\/+$/, "");
	let res: Response;
	let response;
	try {
		res = await fetch(`${upstreamUrl}/chat/${action}`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Accept: "application/json" },
			body: JSON.stringify({
				question: data.question,
				...("answer" in data ? { answer: data.answer } : {}),
			}),
			signal: AbortSignal.timeout(40_000),
		});
		response = await res.json();
	} catch {
		return json(
			{
				error:
					"Could not reach the course service. Check the Canvas forum before resending a Contact TA request.",
			},
			{ status: 502 }
		);
	}
	if (res.ok && response && !response.error && ["ok", "success"].includes(response.status)) {
		const path = `studentFeedback.${data.messageId}`;
		const fields: Record<string, boolean | string> =
			action === "report-hallucination"
				? { [`${path}.hallucinationReported`]: true }
				: {
						[`${path}.canvasPosted`]: true,
						...(typeof response.url === "string" && /^https?:\/\//i.test(response.url)
							? { [`${path}.canvasUrl`]: response.url }
							: {}),
					};
		try {
			const saved = await collections.conversations.updateOne(filter, { $set: fields });
			if (saved.matchedCount === 0) throw new Error("Conversation no longer exists");
		} catch {
			return json(
				{
					error:
						"Your request was sent, but its status could not be saved. Check with the TA or on Canvas before sending again.",
				},
				{ status: 500 }
			);
		}
	}
	return json(response, { status: res.status });
}
