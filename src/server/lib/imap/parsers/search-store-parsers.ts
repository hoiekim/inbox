/**
 * SEARCH and STORE command parsing
 */

import { ParseContext, ParseResult, ImapRequest, SearchRequest, StoreRequest, CopyRequest, StoreOperation } from '../types';
import { parseSequenceSet, skipWhitespace, parseString, parseAtom, peek, consume } from './primitive-parsers';

/**
 * Runtime validation for StoreOperation
 */
const isStoreOperation = (value: string): value is StoreOperation => {
  const validOperations: StoreOperation[] = [
    'FLAGS', 'FLAGS.SILENT', '+FLAGS', '+FLAGS.SILENT', '-FLAGS', '-FLAGS.SILENT'
  ];
  return validOperations.includes(value as StoreOperation);
};

/**
 * Create a simple search criterion from string (temporary implementation)
 */
const createSearchCriterion = (criterion: string): any => {
  // For now, return a simple ALL criterion structure
  // This should be expanded to handle all IMAP search criteria
  const upper = criterion.toUpperCase();
  
  switch (upper) {
    case 'ALL':
      return { type: 'ALL' };
    case 'ANSWERED':
      return { type: 'ANSWERED' };
    case 'DELETED':
      return { type: 'DELETED' };
    case 'FLAGGED':
      return { type: 'FLAGGED' };
    case 'NEW':
      return { type: 'NEW' };
    case 'OLD':
      return { type: 'OLD' };
    case 'RECENT':
      return { type: 'RECENT' };
    case 'SEEN':
      return { type: 'SEEN' };
    case 'UNANSWERED':
      return { type: 'UNANSWERED' };
    case 'UNDELETED':
      return { type: 'UNDELETED' };
    case 'UNFLAGGED':
      return { type: 'UNFLAGGED' };
    case 'UNSEEN':
      return { type: 'UNSEEN' };
    default:
      // For unknown criteria, create a generic text criterion
      return { type: 'TEXT', value: criterion };
  }
};

/**
 * Parse SEARCH command
 */
export const parseSearch = (context: ParseContext): ParseResult<ImapRequest> => {
  const criteria: any[] = [];
  
  while (context.position < context.length) {
    skipWhitespace(context);
    
    if (context.position >= context.length) break;
    
    const criterion = parseAtom(context);
    if (!criterion.success) {
      const str = parseString(context);
      if (str.success) {
        criteria.push(createSearchCriterion(str.value!));
      } else {
        break;
      }
    } else {
      criteria.push(createSearchCriterion(criterion.value!));
    }
  }
  
  return {
    success: true,
    value: {
      type: 'SEARCH',
      data: { criteria }
    },
    consumed: context.position
  };
};

/**
 * Parse STORE command
 */
export const parseStore = (context: ParseContext): ParseResult<ImapRequest> => {
  const sequenceSet = parseSequenceSet(context);
  if (!sequenceSet.success) {
    return { success: false, error: 'Invalid sequence set in STORE', consumed: 0 };
  }
  
  skipWhitespace(context);
  
  const itemName = parseAtom(context);
  if (!itemName.success) {
    return { success: false, error: 'Invalid item name in STORE', consumed: 0 };
  }
  
  const operation = itemName.value!.toUpperCase();
  
  if (!isStoreOperation(operation)) {
    return { success: false, error: `Invalid store operation: ${operation}`, consumed: 0 };
  }
  
  const silent = operation.includes('.SILENT');
  
  skipWhitespace(context);
  
  // Parse flags list
  const flags: string[] = [];
  
  if (peek(context) === '(') {
    context.position++; // consume '('
    
    while (context.position < context.length) {
      skipWhitespace(context);
      
      if (peek(context) === ')') {
        context.position++; // consume ')'
        break;
      }
      
      const flag = parseAtom(context);
      if (!flag.success) {
        return { success: false, error: 'Invalid flag in STORE', consumed: 0 };
      }
      
      flags.push(flag.value!);
      
      skipWhitespace(context);
    }
  } else {
    // Single flag without parentheses
    const flag = parseAtom(context);
    if (!flag.success) {
      return { success: false, error: 'Invalid flag in STORE', consumed: 0 };
    }
    flags.push(flag.value!);
  }
  
  return {
    success: true,
    value: {
      type: 'STORE',
      data: {
        sequenceSet: sequenceSet.value!,
        operation: operation,
        flags,
        silent
      }
    },
    consumed: context.position
  };
};

/**
 * Parse COPY command
 */
export const parseCopy = (context: ParseContext): ParseResult<ImapRequest> => {
  const sequenceSet = parseSequenceSet(context);
  if (!sequenceSet.success) {
    return { success: false, error: 'Invalid sequence set in COPY', consumed: 0 };
  }
  
  skipWhitespace(context);
  
  const mailbox = parseString(context);
  if (!mailbox.success) {
    return { success: false, error: 'Invalid mailbox name in COPY', consumed: 0 };
  }
  
  return {
    success: true,
    value: {
      type: 'COPY',
      data: {
        sequenceSet: sequenceSet.value!,
        mailbox: mailbox.value!
      }
    },
    consumed: context.position
  };
};
