/**
 * Mailbox operation command parsing
 */

import { ParseContext, ParseResult, ImapRequest, StatusItem } from '../types';
import { skipWhitespace, parseString, parseAtom, peek, consume } from './primitive-parsers';

/**
 * Parse LIST command
 */
export const parseList = (command: string, context: ParseContext): ParseResult<ImapRequest> => {
  skipWhitespace(context);
  
  const referenceName = parseString(context);
  if (!referenceName.success) {
    return { success: false, error: 'Invalid reference name in LIST', consumed: 0 };
  }
  
  skipWhitespace(context);
  
  const mailboxName = parseString(context);
  if (!mailboxName.success) {
    return { success: false, error: 'Invalid mailbox name in LIST', consumed: 0 };
  }
  
  return {
    success: true,
    value: {
      type: command === 'LSUB' ? 'LSUB' : 'LIST',
      data: {
        reference: referenceName.value!,
        pattern: mailboxName.value!
      }
    },
    consumed: context.position
  };
};

/**
 * Parse SELECT/EXAMINE command
 */
export const parseSelect = (readOnly: boolean, context: ParseContext): ParseResult<ImapRequest> => {
  skipWhitespace(context);
  
  const mailbox = parseString(context);
  if (!mailbox.success) {
    return { success: false, error: 'Invalid mailbox name', consumed: 0 };
  }
  
  return {
    success: true,
    value: {
      type: readOnly ? 'EXAMINE' : 'SELECT',
      data: { mailbox: mailbox.value! }
    },
    consumed: context.position
  };
};

/**
 * Parse STATUS command
 */
export const parseStatus = (context: ParseContext): ParseResult<ImapRequest> => {
  skipWhitespace(context);
  
  const mailbox = parseString(context);
  if (!mailbox.success) {
    return { success: false, error: 'Invalid mailbox name in STATUS', consumed: 0 };
  }
  
  skipWhitespace(context);
  
  // Parse status items list
  if (!consume(context, '(')) {
    return { success: false, error: 'Expected opening parenthesis in STATUS', consumed: 0 };
  }
  
  const items: StatusItem[] = [];
  
  while (context.position < context.length) {
    skipWhitespace(context);
    
    if (peek(context) === ')') {
      context.position++; // consume ')'
      break;
    }
    
    const item = parseAtom(context);
    if (!item.success) {
      return { success: false, error: 'Invalid status item', consumed: 0 };
    }
    
    const itemName = item.value!.toUpperCase();
    switch (itemName) {
      case 'MESSAGES':
      case 'RECENT':
      case 'UIDNEXT':
      case 'UIDVALIDITY':
      case 'UNSEEN':
        items.push(itemName as StatusItem);
        break;
      default:
        return { success: false, error: `Unknown status item: ${itemName}`, consumed: 0 };
    }
    
    skipWhitespace(context);
  }
  
  return {
    success: true,
    value: {
      type: 'STATUS',
      data: {
        mailbox: mailbox.value!,
        items
      }
    },
    consumed: context.position
  };
};

/**
 * Parse CREATE command
 */
export const parseCreate = (context: ParseContext): ParseResult<ImapRequest> => {
  skipWhitespace(context);
  
  const mailbox = parseString(context);
  if (!mailbox.success) {
    return { success: false, error: 'Invalid mailbox name in CREATE', consumed: 0 };
  }
  
  return {
    success: true,
    value: {
      type: 'CREATE',
      data: { mailbox: mailbox.value! }
    },
    consumed: context.position
  };
};

/**
 * Parse DELETE command
 */
export const parseDelete = (context: ParseContext): ParseResult<ImapRequest> => {
  skipWhitespace(context);
  
  const mailbox = parseString(context);
  if (!mailbox.success) {
    return { success: false, error: 'Invalid mailbox name in DELETE', consumed: 0 };
  }
  
  return {
    success: true,
    value: {
      type: 'DELETE',
      data: { mailbox: mailbox.value! }
    },
    consumed: context.position
  };
};

/**
 * Parse RENAME command
 */
export const parseRename = (context: ParseContext): ParseResult<ImapRequest> => {
  skipWhitespace(context);
  
  const existingName = parseString(context);
  if (!existingName.success) {
    return { success: false, error: 'Invalid existing mailbox name in RENAME', consumed: 0 };
  }
  
  skipWhitespace(context);
  
  const newName = parseString(context);
  if (!newName.success) {
    return { success: false, error: 'Invalid new mailbox name in RENAME', consumed: 0 };
  }
  
  return {
    success: true,
    value: {
      type: 'RENAME',
      data: {
        oldName: existingName.value!,
        newName: newName.value!
      }
    },
    consumed: context.position
  };
};

/**
 * Parse SUBSCRIBE command
 */
export const parseSubscribe = (context: ParseContext): ParseResult<ImapRequest> => {
  skipWhitespace(context);
  
  const mailbox = parseString(context);
  if (!mailbox.success) {
    return { success: false, error: 'Invalid mailbox name in SUBSCRIBE', consumed: 0 };
  }
  
  return {
    success: true,
    value: {
      type: 'SUBSCRIBE',
      data: { mailbox: mailbox.value! }
    },
    consumed: context.position
  };
};

/**
 * Parse UNSUBSCRIBE command
 */
export const parseUnsubscribe = (context: ParseContext): ParseResult<ImapRequest> => {
  skipWhitespace(context);
  
  const mailbox = parseString(context);
  if (!mailbox.success) {
    return { success: false, error: 'Invalid mailbox name in UNSUBSCRIBE', consumed: 0 };
  }
  
  return {
    success: true,
    value: {
      type: 'UNSUBSCRIBE',
      data: { mailbox: mailbox.value! }
    },
    consumed: context.position
  };
};
