/**
 * FETCH command parsing
 */

import { ParseContext, ParseResult, ImapRequest, FetchDataItem, BodyFetch, BodySection, PartialRange } from '../types';
import { parseSequenceSet, skipWhitespace, peek, parseAtom } from './primitive-parsers';

/**
 * Parse FETCH command
 */
export const parseFetch = (context: ParseContext): ParseResult<ImapRequest> => {
  const sequenceSet = parseSequenceSet(context);
  if (!sequenceSet.success) {
    return { success: false, error: 'Invalid sequence set in FETCH', consumed: 0 };
  }

  skipWhitespace(context);

  const dataItems = parseFetchDataItems(context);
  if (!dataItems.success) {
    return { success: false, error: 'Invalid data items in FETCH', consumed: 0 };
  }

  return {
    success: true,
    value: {
      type: 'FETCH',
      data: {
        sequenceSet: sequenceSet.value!,
        dataItems: dataItems.value!
      }
    },
    consumed: context.position
  };
};

/**
 * Parse FETCH data items (parenthesized list or single item)
 */
export const parseFetchDataItems = (context: ParseContext): ParseResult<FetchDataItem[]> => {
  const items: FetchDataItem[] = [];

  skipWhitespace(context);

  // Check if it's a parenthesized list
  if (peek(context) === '(') {
    context.position++; // consume '('
    
    while (context.position < context.length) {
      skipWhitespace(context);
      
      if (peek(context) === ')') {
        context.position++; // consume ')'
        break;
      }
      
      const item = parseFetchDataItem(context);
      if (!item.success) {
        return { success: false, error: 'Invalid fetch data item', consumed: 0 };
      }
      
      items.push(item.value!);
      
      skipWhitespace(context);
      
      // Optional space between items
      if (peek(context) !== ')') {
        skipWhitespace(context);
      }
    }
  } else {
    // Single item
    const item = parseFetchDataItem(context);
    if (!item.success) {
      return { success: false, error: 'Invalid fetch data item', consumed: 0 };
    }
    items.push(item.value!);
  }

  return { success: true, value: items, consumed: context.position };
};

/**
 * Parse a single FETCH data item
 */
export const parseFetchDataItem = (context: ParseContext): ParseResult<FetchDataItem> => {
  const start = context.position;
  
  // Try to parse as atom first
  const atom = parseAtom(context);
  if (!atom.success) {
    return { success: false, error: 'Expected fetch data item', consumed: 0 };
  }
  
  const itemName = atom.value!.toUpperCase();
  
  // Handle simple items
  switch (itemName) {
    case 'ENVELOPE':
      return { success: true, value: { type: 'ENVELOPE' }, consumed: context.position - start };
    case 'FLAGS':
      return { success: true, value: { type: 'FLAGS' }, consumed: context.position - start };
    case 'INTERNALDATE':
      return { success: true, value: { type: 'INTERNALDATE' }, consumed: context.position - start };
    case 'RFC822':
      return { success: true, value: { type: 'RFC822' }, consumed: context.position - start };
    case 'RFC822.HEADER':
      return { success: true, value: { type: 'RFC822.HEADER' }, consumed: context.position - start };
    case 'RFC822.SIZE':
      return { success: true, value: { type: 'RFC822.SIZE' }, consumed: context.position - start };
    case 'RFC822.TEXT':
      return { success: true, value: { type: 'RFC822.TEXT' }, consumed: context.position - start };
    case 'UID':
      return { success: true, value: { type: 'UID' }, consumed: context.position - start };
    case 'BODYSTRUCTURE':
      return { success: true, value: { type: 'BODYSTRUCTURE' }, consumed: context.position - start };
  }
  
  // Handle BODY items
  if (itemName.startsWith('BODY')) {
    const bodyResult = parseBodyFetch(itemName, context);
    if (bodyResult.success) return bodyResult;
  }
  
  return { success: false, error: `Unknown fetch data item: ${itemName}`, consumed: 0 };
};

/**
 * Parse BODY fetch expressions
 */
export const parseBodyFetch = (bodyExpr: string, _context: ParseContext): ParseResult<BodyFetch> => {
  // Handle BODY (without section)
  if (bodyExpr === 'BODY') {
    return { 
      success: true, 
      value: { 
        type: 'BODY', 
        peek: false, 
        section: { type: 'FULL' } 
      }, 
      consumed: 0 
    };
  }
  
  // Handle BODY.PEEK
  if (bodyExpr === 'BODY.PEEK') {
    return { 
      success: true, 
      value: { 
        type: 'BODY', 
        peek: true, 
        section: { type: 'FULL' } 
      }, 
      consumed: 0 
    };
  }
  
  // Handle BODY[section] or BODY[section]<partial>
  const sectionMatch = bodyExpr.match(/^BODY(?:\.PEEK)?\[(.*?)\](.*)$/);
  if (sectionMatch) {
    const [, sectionStr, remainder] = sectionMatch;
    const peek = bodyExpr.includes('.PEEK');
    
    const section = parseBodySection(sectionStr);
    if (!section.success) {
      return { success: false, error: 'Invalid body section', consumed: 0 };
    }
    
    let partial: PartialRange | undefined;
    
    // Check for partial range <start.length>
    const partialMatch = remainder.match(/^<(\d+)\.(\d+)>$/);
    if (partialMatch) {
      const [, startStr, lengthStr] = partialMatch;
      partial = {
        start: parseInt(startStr, 10),
        length: parseInt(lengthStr, 10)
      };
    }
    
    return {
      success: true,
      value: {
        type: 'BODY',
        peek,
        section: section.value!,
        partial
      },
      consumed: 0
    };
  }
  
  return { success: false, error: `Invalid body expression: ${bodyExpr}`, consumed: 0 };
};

/**
 * Parse BODY section specifier
 */
export const parseBodySection = (sectionStr: string): ParseResult<BodySection> => {
  if (!sectionStr) {
    return { success: true, value: { type: 'FULL' }, consumed: 0 };
  }
  
  const upperSection = sectionStr.toUpperCase();
  
  // Handle simple sections
  switch (upperSection) {
    case 'HEADER':
      return { success: true, value: { type: 'HEADER' }, consumed: 0 };
    case 'TEXT':
      return { success: true, value: { type: 'TEXT' }, consumed: 0 };
  }
  
  // Handle HEADER.FIELDS and HEADER.FIELDS.NOT
  if (upperSection.startsWith('HEADER.FIELDS.NOT ')) {
    const fieldsStr = sectionStr.substring('HEADER.FIELDS.NOT '.length);
    const fields = parseHeaderFields(fieldsStr);
    return {
      success: true,
      value: { type: 'HEADER_FIELDS', not: true, fields },
      consumed: 0
    };
  }
  
  if (upperSection.startsWith('HEADER.FIELDS ')) {
    const fieldsStr = sectionStr.substring('HEADER.FIELDS '.length);
    const fields = parseHeaderFields(fieldsStr);
    return {
      success: true,
      value: { type: 'HEADER_FIELDS', not: false, fields },
      consumed: 0
    };
  }
  
  // Handle part numbers (e.g., "1", "1.2", "1.2.3")
  if (/^\d+(\.\d+)*$/.test(sectionStr)) {
    return {
      success: true,
      value: { type: 'MIME_PART', partNumber: sectionStr },
      consumed: 0
    };
  }
  
  // Handle part with subsection (e.g., "1.HEADER", "1.2.TEXT")
  const partMatch = sectionStr.match(/^(\d+(?:\.\d+)*)\.(HEADER|TEXT|MIME)$/i);
  if (partMatch) {
    const [, partNumber, subsection] = partMatch;
    return {
      success: true,
      value: {
        type: 'MIME_PART',
        partNumber,
        subSection: subsection.toUpperCase() as 'HEADER' | 'TEXT' | 'MIME'
      },
      consumed: 0
    };
  }
  
  return { success: false, error: `Invalid body section: ${sectionStr}`, consumed: 0 };
};

/**
 * Parse header field list from parentheses
 */
const parseHeaderFields = (fieldsStr: string): string[] => {
  // Remove parentheses and split by spaces
  const cleaned = fieldsStr.replace(/[()]/g, '').trim();
  if (!cleaned) return [];
  
  return cleaned.split(/\s+/).map(field => field.toUpperCase());
};
