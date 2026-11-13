import { describe, expect, it } from "vitest";

import { DomainError } from "../../shared/domain/errors";
import {
  DOCUMENT_STEP_KEYS,
  DOCUMENT_WORKFLOW,
  buildSlug,
  buildSummary,
  extractDocument,
  extractFields,
  extractFromNormalized,
  extractKeywords,
  faultToError,
  getStepPolicy,
  injectedFault,
  normalizeContent,
  validateDocumentInput,
  validateExtraction,
  verifyExtractionDigest,
  type DocumentInput,
} from "../../shared/workflow/document";

const input: DocumentInput = {
  title: "Quarterly Operations Review",
  document: [
    "Owner: Ada Lovelace",
    "Status: approved",
    "",
    "The operations team reviewed the quarter. Revenue grew steadily across all regions.",
    "Latency improved after the migration. The migration also reduced incident volume.",
    "Workflow reliability is now the main investment area.",
  ].join("\n"),
};

describe("document workflow manifest", () => {
  it("declares the five deterministic steps in order", () => {
    expect(DOCUMENT_STEP_KEYS).toEqual([
      "validate-input",
      "normalize-content",
      "extract-insights",
      "validate-output",
      "persist-result",
    ]);
    expect(DOCUMENT_WORKFLOW.steps.map((step) => step.ordinal)).toEqual([1, 2, 3, 4, 5]);
  });

  it("only retries the steps that can fail transiently", () => {
    expect(getStepPolicy("validate-input").retry.maxAttempts).toBe(1);
    expect(getStepPolicy("validate-output").retry.maxAttempts).toBe(1);
    expect(getStepPolicy("normalize-content").retry.maxAttempts).toBe(3);
    expect(getStepPolicy("extract-insights").retry.maxAttempts).toBe(3);
    expect(getStepPolicy("persist-result").retry.maxAttempts).toBe(3);
  });

  it("rejects an unknown step key", () => {
    expect(() => getStepPolicy("missing" as never)).toThrow("Unknown step");
  });
});

describe("validateDocumentInput", () => {
  it("accepts a valid document and trims the title", () => {
    const parsed = validateDocumentInput({ ...input, title: "  Operations Review  " });
    expect(parsed.title).toBe("Operations Review");
  });

  it("rejects a short title", () => {
    expect(() => validateDocumentInput({ ...input, title: "ab" })).toThrow(DomainError);
  });

  it("rejects a short document", () => {
    expect(() => validateDocumentInput({ ...input, document: "too short" })).toThrow(DomainError);
  });

  it("rejects unknown properties instead of silently dropping them", () => {
    expect(() => validateDocumentInput({ ...input, extra: true })).toThrow(DomainError);
  });

  it("exposes a safe validation code", () => {
    try {
      validateDocumentInput({ ...input, title: "ab" });
      expect.unreachable("expected validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      expect((error as DomainError).code).toBe("INVALID_DOCUMENT_INPUT");
      expect((error as DomainError).errorClass).toBe("VALIDATION");
      expect((error as DomainError).retryable).toBe(false);
    }
  });
});

describe("normalizeContent", () => {
  it("normalizes line endings, whitespace and paragraph gaps", () => {
    const normalized = normalizeContent({
      title: "Normalization",
      document: "First   line.\r\n\r\n\r\n\r\nSecond\tline.\r\n",
    });
    expect(normalized.text).toBe("First line.\n\nSecond line.");
    expect(normalized.characterCount).toBe(normalized.text.length);
    expect(normalized.paragraphCount).toBe(2);
  });

  it("computes word, sentence and reading-time statistics", () => {
    const normalized = normalizeContent({
      title: "Statistics",
      document: "One two three. Four five six! Seven eight nine?",
    });
    expect(normalized.wordCount).toBe(9);
    expect(normalized.sentenceCount).toBe(3);
    expect(normalized.readingTimeSeconds).toBeGreaterThanOrEqual(1);
  });

  it("rejects a document that normalizes to nothing", () => {
    expect(() =>
      normalizeContent({ title: "Empty", document: "                          " }),
    ).toThrow(DomainError);
  });
});

describe("deterministic extraction", () => {
  it("builds a URL-safe slug", () => {
    expect(buildSlug("Café Déjà Vu — 2026")).toBe("cafe-deja-vu-2026");
    expect(buildSlug("  ***  ")).toBe("");
  });

  it("extracts labelled fields and ignores duplicates", () => {
    const fields = extractFields(
      "Owner: Ada Lovelace\nStatus: approved\nnot a field: nope\nOwner: Grace Hopper",
    );
    expect(fields).toEqual([
      { key: "Owner", value: "Ada Lovelace" },
      { key: "Status", value: "approved" },
    ]);
  });

  it("caps labelled fields at twenty", () => {
    const document = Array.from({ length: 30 }, (_, index) => `Field${index}: value`).join("\n");
    expect(extractFields(document)).toHaveLength(20);
  });

  it("ranks keywords while removing stopwords and short tokens", () => {
    const keywords = extractKeywords(
      "workflow workflow workflow reliability reliability incident the and a an is of to",
    );
    expect(keywords).toEqual([
      { term: "workflow", count: 3 },
      { term: "reliability", count: 2 },
      { term: "incident", count: 1 },
    ]);
  });

  it("caps the summary at 280 characters", () => {
    const summary = buildSummary(`${"word ".repeat(100)}.`);
    expect(summary.length).toBeLessThanOrEqual(280);
  });

  it("produces the same digest for the same normalized input", async () => {
    const first = await extractDocument(input);
    const second = await extractDocument(input);
    expect(first.digest).toBe(second.digest);
    expect(first.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(first.slug).toBe("quarterly-operations-review");
    expect(first.fields).toEqual([
      { key: "Owner", value: "Ada Lovelace" },
      { key: "Status", value: "approved" },
    ]);
  });

  it("produces a different digest when the content changes", async () => {
    const normalized = normalizeContent(input);
    const first = await extractFromNormalized(input.title, normalized);
    const second = await extractFromNormalized(input.title, {
      ...normalized,
      text: `${normalized.text}\nAn additional sentence.`,
    });
    expect(first.digest).not.toBe(second.digest);
  });

  it("validates and re-verifies its own output", async () => {
    const extraction = await extractDocument(input);
    expect(() => validateExtraction(extraction)).not.toThrow();
    await expect(verifyExtractionDigest(extraction)).resolves.toBeUndefined();
  });

  it("detects a tampered extraction", async () => {
    const extraction = await extractDocument(input);
    const tampered = { ...extraction, summary: "A different summary." };
    await expect(verifyExtractionDigest(tampered)).rejects.toBeInstanceOf(DomainError);
  });
});

describe("allowlisted fault injection", () => {
  it("only injects into this one step on its first attempt", () => {
    expect(injectedFault("success", "extract-insights", 1)).toBeNull();
    expect(injectedFault("retryable_failure", "normalize-content", 1)).toBeNull();
    expect(injectedFault("retryable_failure", "extract-insights", 1)).toMatchObject({
      kind: "transient",
    });
    expect(injectedFault("retryable_failure", "extract-insights", 2)).toBeNull();
    expect(injectedFault("terminal_failure", "extract-insights", 1)).toMatchObject({
      kind: "terminal",
    });
  });

  it("maps faults to retryable and permanent domain errors", () => {
    const transient = injectedFault("retryable_failure", "extract-insights", 1);
    const terminal = injectedFault("terminal_failure", "extract-insights", 1);
    expect(transient).not.toBeNull();
    expect(terminal).not.toBeNull();

    const transientError = faultToError(transient!);
    expect(transientError.retryable).toBe(true);
    expect(transientError.errorClass).toBe("TRANSIENT_DEPENDENCY");

    const terminalError = faultToError(terminal!);
    expect(terminalError.retryable).toBe(false);
    expect(terminalError.errorClass).toBe("PERMANENT_APPLICATION");
  });
});
