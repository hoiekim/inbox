/* eslint-disable no-case-declarations */
import {
  ImapRequest,
  ParseContext,
  ParseResult,
  SearchCriterion
} from "../types";
import {
  parseAtom,
  parseDate,
  parseNumber,
  parseSequenceSet,
  skipWhitespace
} from "./primitive-parsers";

/**
 * Parse SEARCH command
 */
export const parseSearch = (
  context: ParseContext
): ParseResult<ImapRequest> => {
  const criteria = parseSearchCriteria(context);

  if (!criteria.success) {
    return {
      success: false,
      error: "Invalid search criteria",
      consumed: 0
    };
  }

  return {
    success: true,
    value: {
      type: "SEARCH",
      data: { criteria: criteria.value! }
    },
    consumed: context.position
  };
};

export const parseSearchCriteria = (
  context: ParseContext
): ParseResult<SearchCriterion[]> => {
  const start = context.position;
  const criteria: SearchCriterion[] = [];

  while (context.position < context.length) {
    skipWhitespace(context);
    const { position } = context;
    // Try to parse as sequence set first
    const sequenceSet = parseSequenceSet(context);
    if (sequenceSet.success) {
      criteria.push({ type: "UID", sequenceSet: sequenceSet.value! });
    } else {
      // reset position if sequence set parse failed
      context.position = position;

      const atom = parseAtom(context);
      const itemName = atom.value!.toUpperCase();

      // Handle simple items
      switch (itemName) {
        case "ALL":
          criteria.push({ type: "ALL" });
          break;
        case "ANSWERED":
          criteria.push({ type: "ANSWERED" });
          break;
        case "DELETED":
          criteria.push({ type: "DELETED" });
          break;
        case "FLAGGED":
          criteria.push({ type: "FLAGGED" });
          break;
        case "NEW":
          criteria.push({ type: "NEW" });
          break;
        case "OLD":
          criteria.push({ type: "OLD" });
          break;
        case "RECENT":
          criteria.push({ type: "RECENT" });
          break;
        case "SEEN":
          criteria.push({ type: "SEEN" });
          break;
        case "UNANSWERED":
          criteria.push({ type: "UNANSWERED" });
          break;
        case "UNDELETED":
          criteria.push({ type: "UNDELETED" });
          break;
        case "UNFLAGGED":
          criteria.push({ type: "UNFLAGGED" });
          break;
        case "UNSEEN":
          criteria.push({ type: "UNSEEN" });
          break;
        case "DRAFT":
          criteria.push({ type: "DRAFT" });
          break;
        case "UNDRAFT":
          criteria.push({ type: "UNDRAFT" });
          break;
        case "KEYWORD":
          const keywordFlag = parseAtom(context);
          if (keywordFlag.success) {
            criteria.push({ type: "KEYWORD", flag: keywordFlag.value! });
          } else {
            return {
              success: false,
              error: "Expected flag after KEYWORD",
              consumed: 0
            };
          }
          break;
        case "UNKEYWORD":
          const unkeywordFlag = parseAtom(context);
          if (unkeywordFlag.success) {
            criteria.push({
              type: "UNKEYWORD",
              flag: unkeywordFlag.value!
            });
          } else {
            return {
              success: false,
              error: "Expected flag after UNKEYWORD",
              consumed: 0
            };
          }
          break;
        case "BEFORE":
          const beforeDate = parseDate(context);
          if (beforeDate.success) {
            criteria.push({
              type: "BEFORE",
              date: beforeDate.value!
            });
          } else {
            return {
              success: false,
              error: "Expected date after BEFORE",
              consumed: 0
            };
          }
          break;
        case "ON":
          const onDate = parseDate(context);
          if (onDate.success) {
            criteria.push({
              type: "ON",
              date: onDate.value!
            });
          } else {
            return {
              success: false,
              error: "Expected date after ON",
              consumed: 0
            };
          }
          break;
        case "SINCE":
          const sinceDate = parseDate(context);
          if (sinceDate.success) {
            criteria.push({
              type: "SINCE",
              date: sinceDate.value!
            });
          } else {
            return {
              success: false,
              error: "Expected date after SINCE",
              consumed: 0
            };
          }
          break;
        case "SENTBEFORE":
          const sentBeforeDate = parseDate(context);
          if (sentBeforeDate.success) {
            criteria.push({
              type: "SENTBEFORE",
              date: sentBeforeDate.value!
            });
          } else {
            return {
              success: false,
              error: "Expected date after SENTBEFORE",
              consumed: 0
            };
          }
          break;
        case "SENTON":
          const sentOnDate = parseDate(context);
          if (sentOnDate.success) {
            criteria.push({
              type: "SENTON",
              date: sentOnDate.value!
            });
          } else {
            return {
              success: false,
              error: "Expected date after SENTON",
              consumed: 0
            };
          }
          break;
        case "SENTSINCE":
          const sentSinceDate = parseDate(context);
          if (sentSinceDate.success) {
            criteria.push({
              type: "SENTSINCE",
              date: sentSinceDate.value!
            });
          } else {
            return {
              success: false,
              error: "Expected date after SENTSINCE",
              consumed: 0
            };
          }
          break;
        case "FROM":
          const fromValue = parseAtom(context);
          if (fromValue.success) {
            criteria.push({
              type: "FROM",
              value: fromValue.value!
            });
          } else {
            return {
              success: false,
              error: "Expected text value after FROM",
              consumed: 0
            };
          }
          break;
        case "TO":
          const toValue = parseAtom(context);
          if (toValue.success) {
            criteria.push({
              type: "TO",
              value: toValue.value!
            });
          } else {
            return {
              success: false,
              error: "Expected text value after TO",
              consumed: 0
            };
          }
          break;
        case "CC":
          const ccValue = parseAtom(context);
          if (ccValue.success) {
            criteria.push({
              type: "CC",
              value: ccValue.value!
            });
          } else {
            return {
              success: false,
              error: "Expected text value after CC",
              consumed: 0
            };
          }
          break;
        case "BCC":
          const bccValue = parseAtom(context);
          if (bccValue.success) {
            criteria.push({
              type: "BCC",
              value: bccValue.value!
            });
          } else {
            return {
              success: false,
              error: "Expected text value after BCC",
              consumed: 0
            };
          }
          break;
        case "SUBJECT":
          const subjectValue = parseAtom(context);
          if (subjectValue.success) {
            criteria.push({
              type: "SUBJECT",
              value: subjectValue.value!
            });
          } else {
            return {
              success: false,
              error: "Expected text value after SUBJECT",
              consumed: 0
            };
          }
          break;
        case "BODY":
          const bodyValue = parseAtom(context);
          if (bodyValue.success) {
            criteria.push({
              type: "BODY",
              value: bodyValue.value!
            });
          } else {
            return {
              success: false,
              error: "Expected text value after BODY",
              consumed: 0
            };
          }
          break;
        case "TEXT":
          const textValue = parseAtom(context);
          if (textValue.success) {
            criteria.push({
              type: "TEXT",
              value: textValue.value!
            });
          } else {
            return {
              success: false,
              error: "Expected text value after TEXT",
              consumed: 0
            };
          }
          break;
        case "HEADER":
          const headerField = parseAtom(context);
          const headerValue = parseAtom(context);
          if (headerField.success && headerValue.success) {
            criteria.push({
              type: "HEADER",
              field: headerField.value!,
              value: headerValue.value!
            });
          } else {
            return {
              success: false,
              error: "Expected field & value after HEADER",
              consumed: 0
            };
          }
          break;
        case "UID":
          const uidSequenceSet = parseSequenceSet(context);
          if (uidSequenceSet.success) {
            criteria.push({
              type: "UID",
              sequenceSet: uidSequenceSet.value!
            });
          } else {
            return {
              success: false,
              error: "Expected sequence set after UID",
              consumed: 0
            };
          }
          break;
        case "LARGER":
          const largerSize = parseNumber(context);
          if (largerSize.success) {
            criteria.push({
              type: "LARGER",
              size: largerSize.value!
            });
          } else {
            return {
              success: false,
              error: "Expected size after LARGER",
              consumed: 0
            };
          }
          break;
        case "SMALLER":
          const smallerSize = parseNumber(context);
          if (smallerSize.success) {
            criteria.push({
              type: "SMALLER",
              size: smallerSize.value!
            });
          } else {
            return {
              success: false,
              error: "Expected size after SMALLER",
              consumed: 0
            };
          }
          break;
        case "NOT":
          const notCriteria = parseSearchCriteria(context);
          if (notCriteria.success && notCriteria.value?.length === 1) {
            criteria.push({
              type: "NOT",
              criterion: notCriteria.value[0]!
            });
          } else {
            return {
              success: false,
              error: "Expected exactly 1 search criterion after NOT",
              consumed: 0
            };
          }
          break;
        case "OR":
          const orCriteria = parseSearchCriteria(context);
          if (orCriteria.success && orCriteria.value?.length === 2) {
            const orCriteriaLeft = orCriteria.value![0];
            const orCriteriaRight = orCriteria.value![1];
            criteria.push({
              type: "OR",
              left: orCriteriaLeft,
              right: orCriteriaRight
            });
          } else {
            return {
              success: false,
              error: "Expected exactly 2 search criteria after OR",
              consumed: 0
            };
          }
          break;
      }
    }
  }

  return {
    success: true,
    value: criteria,
    consumed: context.position - start
  };
};
