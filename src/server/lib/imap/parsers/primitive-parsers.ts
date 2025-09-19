/**
 * Basic IMAP parsing primitives
 */

import {
  ParseContext,
  ParseResult,
  SequenceSet,
  SequenceRange
} from "../types";

/**
 * Parse an IMAP atom (unquoted string)
 */
export const parseAtom = (context: ParseContext): ParseResult<string> => {
  const start = context.position;

  while (context.position < context.length) {
    const char = context.input[context.position];

    // ATOM-CHAR = <any CHAR except atom-specials>
    // atom-specials = "(" / ")" / "{" / SP / CTL / list-wildcards / quoted-specials
    if (
      char === " " ||
      char === "(" ||
      char === ")" ||
      char === "{" ||
      char === '"' ||
      char === "\\" ||
      char === "\r" ||
      char === "\n" ||
      char === "*" ||
      char === "%" ||
      char.charCodeAt(0) < 32
    ) {
      break;
    }

    context.position++;
  }

  if (context.position === start) {
    return { success: false, error: "Expected atom", consumed: 0 };
  }

  return {
    success: true,
    value: context.input.substring(start, context.position),
    consumed: context.position - start
  };
};

export const parseDate = (context: ParseContext): ParseResult<Date> => {
  const start = context.position;
  const atom = parseAtom(context);
  const date = new Date(atom.value!);
  if (!atom.success) {
    return {
      success: atom.success,
      error: atom.error,
      consumed: atom.consumed
    };
  }
  if (isNaN(date.getTime())) {
    context.position = start; // reset position on failure
    return { success: false, error: "Invalid date", consumed: 0 };
  }
  return { success: true, value: date, consumed: atom.consumed };
};

/**
 * Parse an IMAP flag (can start with backslash)
 */
export const parseFlag = (context: ParseContext): ParseResult<string> => {
  const start = context.position;

  // Handle flags that start with backslash
  if (peek(context) === "\\") {
    context.position++;
  }

  while (context.position < context.length) {
    const char = context.input[context.position];

    // Stop at whitespace, parentheses, or other delimiters
    if (
      char === " " ||
      char === "(" ||
      char === ")" ||
      char === "{" ||
      char === '"' ||
      char === "\r" ||
      char === "\n" ||
      char === "*" ||
      char === "%" ||
      char.charCodeAt(0) < 32
    ) {
      break;
    }

    context.position++;
  }

  if (context.position === start) {
    return { success: false, error: "Expected flag", consumed: 0 };
  }

  return {
    success: true,
    value: context.input.substring(start, context.position),
    consumed: context.position - start
  };
};

/**
 * Parse a string (quoted or literal)
 */
export const parseString = (context: ParseContext): ParseResult<string> => {
  if (peek(context) === '"') {
    return parseQuotedString(context);
  }

  // For now, just parse as atom if not quoted
  return parseAtom(context);
};

/**
 * Parse a quoted string
 */
export const parseQuotedString = (
  context: ParseContext
): ParseResult<string> => {
  if (!consume(context, '"')) {
    return { success: false, error: "Expected opening quote", consumed: 0 };
  }

  const start = context.position;
  let result = "";

  while (context.position < context.length) {
    const char = context.input[context.position];

    if (char === '"') {
      context.position++;
      return {
        success: true,
        value: result,
        consumed: context.position - start + 1
      };
    }

    if (char === "\\" && context.position + 1 < context.length) {
      context.position++;
      result += context.input[context.position];
    } else {
      result += char;
    }

    context.position++;
  }

  return { success: false, error: "Unterminated quoted string", consumed: 0 };
};

/**
 * Parse a sequence set (e.g., "1:5,7,9:*")
 */
export const parseSequenceSet = (
  context: ParseContext
): ParseResult<SequenceSet> => {
  const ranges: SequenceRange[] = [];

  while (context.position < context.length) {
    skipWhitespace(context);

    if (context.position >= context.length) break;

    // Parse first number or *
    let start: number;
    if (peek(context) === "*") {
      start = Number.MAX_SAFE_INTEGER;
      context.position++;
    } else {
      const num = parseNumber(context);
      if (!num.success) break;
      start = num.value!;
    }

    // Check for range (:)
    if (peek(context) === ":") {
      context.position++; // consume ':'

      let end: number;
      if (peek(context) === "*") {
        end = Number.MAX_SAFE_INTEGER;
        context.position++;
      } else {
        const num = parseNumber(context);
        if (!num.success) {
          return { success: false, error: "Invalid range end", consumed: 0 };
        }
        end = num.value!;
      }

      ranges.push({ start, end });
    } else {
      // Single number
      ranges.push({ start });
    }

    // Check for comma (more sequences)
    skipWhitespace(context);
    if (peek(context) === ",") {
      context.position++;
    } else {
      break;
    }
  }

  if (ranges.length === 0) {
    return { success: false, error: "Empty sequence set", consumed: 0 };
  }

  return {
    success: true,
    value: {
      type: "sequence", // Default to sequence, will be overridden for UID commands
      ranges
    },
    consumed: context.position
  };
};

/**
 * Parse a number
 */
export const parseNumber = (context: ParseContext): ParseResult<number> => {
  const start = context.position;

  while (context.position < context.length) {
    const char = context.input[context.position];
    if (char >= "0" && char <= "9") {
      context.position++;
    } else {
      break;
    }
  }

  if (context.position === start) {
    return { success: false, error: "Expected number", consumed: 0 };
  }

  const value = parseInt(context.input.substring(start, context.position), 10);
  return { success: true, value, consumed: context.position - start };
};

/**
 * Skip whitespace characters
 */
export const skipWhitespace = (context: ParseContext): void => {
  while (
    context.position < context.length &&
    context.input[context.position] === " "
  ) {
    context.position++;
  }
};

/**
 * Peek at the current character without consuming it
 */
export const peek = (context: ParseContext): string => {
  return context.position < context.length
    ? context.input[context.position]
    : "";
};

/**
 * Consume expected string, return true if successful
 */
export const consume = (context: ParseContext, expected: string): boolean => {
  if (
    context.input.substring(
      context.position,
      context.position + expected.length
    ) === expected
  ) {
    context.position += expected.length;
    return true;
  }
  return false;
};
