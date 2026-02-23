import { MailDataToSend, MailDataToSendType } from "common";
import { isValidEmail } from "server";

const MAX_SUBJECT_LENGTH = 998; // RFC 2822 line limit
const MAX_HTML_LENGTH = 10 * 1024 * 1024; // 10MB

export interface ValidationResult {
  valid: boolean;
  error?: string;
}

const validateEmailList = (
  emails: string | undefined,
  fieldName: string
): ValidationResult => {
  if (!emails) return { valid: true };

  const list = emails
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean);

  for (const email of list) {
    if (!isValidEmail(email)) {
      return { valid: false, error: `Invalid ${fieldName} address: ${email}` };
    }
  }

  return { valid: true };
};

export const validateMailData = (
  data: MailDataToSendType | MailDataToSend
): ValidationResult => {
  // Validate sender (required, local part of email)
  if (!data.sender || typeof data.sender !== "string") {
    return { valid: false, error: "Sender is required" };
  }

  // Local part validation: alphanumeric, dots, hyphens, underscores
  if (!/^[a-zA-Z0-9._-]+$/.test(data.sender)) {
    return { valid: false, error: "Invalid sender format" };
  }

  // Validate senderFullName for header injection (no CRLF)
  if (data.senderFullName && /[\r\n]/.test(data.senderFullName)) {
    return { valid: false, error: "Invalid sender name" };
  }

  // Validate recipient (required)
  if (!data.to || typeof data.to !== "string") {
    return { valid: false, error: "Recipient email address is required" };
  }

  const toResult = validateEmailList(data.to, "recipient");
  if (!toResult.valid) return toResult;

  // Validate cc (optional)
  const ccResult = validateEmailList(data.cc, "CC");
  if (!ccResult.valid) return ccResult;

  // Validate bcc (optional)
  const bccResult = validateEmailList(data.bcc, "BCC");
  if (!bccResult.valid) return bccResult;

  // Validate length limits
  if (data.subject && data.subject.length > MAX_SUBJECT_LENGTH) {
    return {
      valid: false,
      error: `Subject exceeds maximum length of ${MAX_SUBJECT_LENGTH} characters`,
    };
  }

  if (data.html && data.html.length > MAX_HTML_LENGTH) {
    return { valid: false, error: "Email body exceeds maximum size of 10MB" };
  }

  return { valid: true };
};

export class MailValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MailValidationError";
  }
}
