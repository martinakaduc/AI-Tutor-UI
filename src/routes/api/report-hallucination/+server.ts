import { forwardStudentFeedback } from "$lib/server/studentFeedback";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = ({ request, locals }) =>
	forwardStudentFeedback(request, "report-hallucination", locals);
