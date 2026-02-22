import { MailDataToSend, MailDataToSendType } from "common";
import { sendMail, AUTH_ERROR_MESSAGE, isValidEmail } from "server";
import { Route } from "../route";

export type SendMailPostResponse = undefined;

export type SendMailPostBody = MailDataToSendType;

const MAX_SUBJECT_LENGTH = 998; // RFC 5322 line length limit
const MAX_BODY_LENGTH = 10 * 1024 * 1024; // 10MB limit for HTML body

const validateEmailList = (emails: string | undefined): string | null => {
  if (!emails) return null;
  const list = emails.split(",").map((e) => e.trim()).filter((e) => e);
  for (const email of list) {
    if (!isValidEmail(email.toLowerCase())) {
      return `Invalid email address: ${email}`;
    }
  }
  return null;
};

export const postSendMailRoute = new Route<SendMailPostResponse>(
  "POST",
  "/send",
  async (req) => {
    const { user } = req.session;
    if (!user) return { status: "failed", message: AUTH_ERROR_MESSAGE };

    const body: SendMailPostBody = req.body;
    const attachments = req.files?.attachments;

    // Validate recipient (required)
    if (!body.to || typeof body.to !== "string" || body.to.trim() === "") {
      return { status: "failed", message: "Recipient email address is required" };
    }

    const toError = validateEmailList(body.to);
    if (toError) return { status: "failed", message: toError };

    // Validate cc (optional)
    const ccError = validateEmailList(body.cc);
    if (ccError) return { status: "failed", message: ccError };

    // Validate bcc (optional)
    const bccError = validateEmailList(body.bcc);
    if (bccError) return { status: "failed", message: bccError };

    // Validate subject length
    if (body.subject && body.subject.length > MAX_SUBJECT_LENGTH) {
      return { status: "failed", message: `Subject exceeds maximum length of ${MAX_SUBJECT_LENGTH} characters` };
    }

    // Validate body length
    if (body.html && body.html.length > MAX_BODY_LENGTH) {
      return { status: "failed", message: "Email body is too large" };
    }

    await sendMail(user, new MailDataToSend({ ...body }), attachments);

    return { status: "success" };
  }
);
