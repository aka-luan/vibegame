import { describe, expect, it } from "vitest";

import invalidContent from "../fixtures/invalid-content.json" with { type: "json" };
import validContent from "../fixtures/valid-content.json" with { type: "json" };
import { validateContent } from "./index.js";

describe("content validation", () => {
  it("accepts a versioned catalog with a stable namespaced identifier", () => {
    expect(validateContent(validContent)).toEqual({ success: true });
  });

  it("reports the stable path and reason for an invalid identifier", () => {
    expect(validateContent(invalidContent)).toEqual({
      success: false,
      issues: [
        {
          path: "definitions[0].id",
          message:
            "Must be a namespaced lowercase identifier such as objective:sample",
        },
      ],
    });
  });

  it("rejects duplicate stable identifiers", () => {
    expect(
      validateContent({
        schemaVersion: 1,
        definitions: [validContent.definitions[0], validContent.definitions[0]],
      }),
    ).toEqual({
      success: false,
      issues: [
        {
          path: "definitions[1].id",
          message: "Duplicate content identifier: objective:foundation_sample",
        },
      ],
    });
  });

  it("reports an unresolved content reference at its stable path", () => {
    expect(
      validateContent({
        schemaVersion: 1,
        definitions: [
          {
            ...validContent.definitions[0],
            references: ["objective:missing"],
          },
        ],
      }),
    ).toEqual({
      success: false,
      issues: [
        {
          path: "definitions[0].references[0]",
          message: "Missing content reference: objective:missing",
        },
      ],
    });
  });
});
