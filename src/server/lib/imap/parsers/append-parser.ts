/**
 * APPEND command parser
 */

import { ParseContext, ParseResult, AppendRequest } from '../types';
import { parseAtom, parseString, skipWhitespace } from './primitive-parsers';

/**
 * Parse APPEND command
 * Format: APPEND mailbox [flags] [date] message
 */
export const parseAppend = (context: ParseContext): ParseResult<{ type: 'APPEND'; data: AppendRequest }> => {
  try {
    // Parse mailbox name
    const mailbox = parseString(context);
    if (!mailbox.success) {
      return { success: false, error: 'Expected mailbox name', consumed: 0 };
    }

    skipWhitespace(context);

    // Parse optional flags - simple implementation
    let flags: string[] | undefined;
    if (context.input[context.position] === '(') {
      context.position++; // Skip '('
      const flagsStr = [];
      while (context.position < context.length && context.input[context.position] !== ')') {
        if (context.input[context.position] === ' ') {
          context.position++;
          continue;
        }
        const flag = parseAtom(context);
        if (flag.success) {
          flagsStr.push(flag.value!);
        } else {
          break;
        }
      }
      if (context.input[context.position] === ')') {
        context.position++; // Skip ')'
        flags = flagsStr;
        skipWhitespace(context);
      }
    }

    // Parse optional date
    let date: string | undefined;
    if (context.input[context.position] === '"') {
      const dateResult = parseString(context);
      if (dateResult.success) {
        date = dateResult.value;
        skipWhitespace(context);
      }
    }

    // Parse message literal
    // IMAP literals are in format {size}\r\n<data>
    if (context.input[context.position] !== '{') {
      return { success: false, error: 'Expected message literal', consumed: 0 };
    }

    // Find the closing brace
    const literalStart = context.position + 1;
    const literalEnd = context.input.indexOf('}', literalStart);
    if (literalEnd === -1) {
      return { success: false, error: 'Invalid literal format', consumed: 0 };
    }

    const sizeStr = context.input.substring(literalStart, literalEnd);
    const size = parseInt(sizeStr, 10);
    if (isNaN(size)) {
      return { success: false, error: 'Invalid literal size', consumed: 0 };
    }

    // Skip to after the }\r\n
    context.position = literalEnd + 1;
    if (context.input.substring(context.position, context.position + 2) === '\r\n') {
      context.position += 2;
    }

    // Extract the message data
    const message = context.input.substring(context.position, context.position + size);
    context.position += size;

    const appendRequest: AppendRequest = {
      mailbox: mailbox.value!,
      flags,
      date,
      message
    };

    return {
      success: true,
      value: { type: 'APPEND', data: appendRequest },
      consumed: context.position
    };
  } catch (error) {
    return { success: false, error: `APPEND parse error: ${error}`, consumed: 0 };
  }
};
