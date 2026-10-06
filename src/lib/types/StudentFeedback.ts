/** Successful student actions on a single assistant response. */
export interface StudentFeedback {
	hallucinationReported?: boolean;
	canvasPosted?: boolean;
	canvasUrl?: string;
}

export interface StudentFeedbackUpdate {
	conversationId: string;
	messageId: string;
	feedback: StudentFeedback;
}
