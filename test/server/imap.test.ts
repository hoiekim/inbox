import { parseCommand } from "../../src/server/lib/imap/parsers";

describe("IMAP parsers", () => {
  const STORE_COMMAND = "1.1 UID STORE 1 +FLAGS.SILENT (\\Seen)";

  it(`should parse "${STORE_COMMAND}"`, () => {
    const result = parseCommand(STORE_COMMAND);
    expect(result.success).toBe(true);
    expect(result.value?.tag).toBe("1.1");
    expect(result.value?.request.type).toBe("UID");
    expect(result.consumed).toBe(37);

    if (result.value?.request.type !== "UID") {
      throw new Error("Expected UID request type");
    }

    const uidRequest = result.value.request;
    expect(uidRequest.data.command).toBe("STORE");

    if (uidRequest.data.request.type !== "STORE") {
      throw new Error("Expected STORE request type");
    }

    const storeRequest = uidRequest.data.request;
    expect(storeRequest.data.operation).toBe("+FLAGS.SILENT");
    expect(storeRequest.data.flags).toEqual(["\\Seen"]);
    expect(storeRequest.data.silent).toBe(true);
  });

  it("should parse FETCH command with range", () => {
    const FETCH_COMMAND = "2.1 FETCH 1:15 (FLAGS ENVELOPE)";
    const result = parseCommand(FETCH_COMMAND);
    expect(result.success).toBe(true);
    expect(result.value?.tag).toBe("2.1");
    expect(result.value?.request.type).toBe("FETCH");

    if (result.value?.request.type !== "FETCH") {
      throw new Error("Expected FETCH request type");
    }

    const fetchRequest = result.value.request;
    expect(fetchRequest.data.sequenceSet.ranges[0].start).toBe(1);
    expect(fetchRequest.data.sequenceSet.ranges[0].end).toBe(15);
  });

  it("should parse UID SEARCH command with multiple criteria", () => {
    const SEARCH_COMMAND = "3.1 UID SEARCH 1,577,5084,9591";
    const result = parseCommand(SEARCH_COMMAND);
    expect(result.success).toBe(true);
    expect(result.value?.tag).toBe("3.1");
    expect(result.value?.request.type).toBe("UID");
    if (result.value?.request.type !== "UID") {
      throw new Error("Expected UID request type");
    }
    const searchCommand = result.value?.request.data;
    expect(searchCommand.request.type).toBe("SEARCH");
    if (searchCommand.request.type !== "SEARCH") {
      throw new Error("Expected SEARCH request type");
    }
    const searchRequest = searchCommand.request;
    const criterion = searchRequest.data.criteria[0];
    expect(criterion.type).toBe("TEXT");
    if (criterion.type !== "TEXT") {
      throw new Error("Expected TEXT criterion type");
    }
    expect(criterion.value).toBe("1,577,5084,9591");
  });
});
