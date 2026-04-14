import { describe, expect, test } from "vitest";
import { WorkToolClient } from "../src/integrations/worktool/worktool.client.js";

describe("deprecated WorkTool client", () => {
  test("should reject all API calls", async () => {
    const client = new WorkToolClient();
    await expect(client.sendRawMessage({ robotId: "x", targetTitle: "g", receivedContent: "t" })).rejects.toThrow(
      /deprecated/i
    );
  });
});
