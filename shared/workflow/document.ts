import { z } from "zod";

import {
  permanentApplicationError,
  transientDependencyError,
  validationError,
} from "../domain/errors";
import type { RetryPolicy } from "../domain/retry";

/**
 * The first Traceyard workflow: a deterministic document-intelligence pipeline.
 *
 * There is no network access and no LLM call. Every operation is a pure,
 * testable transformation, which makes the workflow suitable for a public
 * sandbox and a reliable reference implementation for the execution engine.
 */

export const documentInputSchema = z
  .object({
    title: z.string().trim().min(3, "Title must be at least 3 characters.").max(120),
    document: z
      .string()
      .min(24, "Document must be at least 24 characters.")
      .max(10_000, "Document must be at most 10,000 characters."),
  })
  .strict();

export type DocumentInput = z.infer<typeof documentInputSchema>;

export const FAILURE_SCENARIOS = ["success", "retryable_failure", "terminal_failure"] as const;
export type FailureScenario = (typeof FAILURE_SCENARIOS)[number];

export const DOCUMENT_STEP_KEYS = [
  "validate-input",
  "normalize-content",
  "extract-insights",
  "validate-output",
  "persist-result",
] as const;

export type DocumentStepKey = (typeof DOCUMENT_STEP_KEYS)[number];

export interface StepPolicy {
  key: DocumentStepKey;
  name: string;
  ordinal: number;
  description: string;
  timeoutMs: number;
  retry: RetryPolicy;
}

const NO_RETRY: RetryPolicy = {
  maxAttempts: 1,
  baseDelayMs: 0,
  backoff: "fixed",
  maxDelayMs: 0,
};

const STANDARD_RETRY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 1_000,
  backoff: "exponential",
  maxDelayMs: 8_000,
};

export const DOCUMENT_WORKFLOW = {
  id: "wf_document_intelligence",
  slug: "document-intelligence",
  name: "Document intelligence",
  version: 1,
  description:
    "Validates, normalizes and extracts structured insight from a bounded document, verifies the result, then commits it idempotently.",
  steps: [
    {
      key: "validate-input",
      name: "Validate input",
      ordinal: 1,
      description: "Re-validate the stored input at the execution boundary.",
      timeoutMs: 10_000,
      retry: NO_RETRY,
    },
    {
      key: "normalize-content",
      name: "Normalize content",
      ordinal: 2,
      description: "Normalize line endings, whitespace and paragraph structure.",
      timeoutMs: 10_000,
      retry: STANDARD_RETRY,
    },
    {
      key: "extract-insights",
      name: "Extract insights",
      ordinal: 3,
      description:
        "Derive keywords, labelled fields, a summary, reading time and a content digest.",
      timeoutMs: 15_000,
      retry: STANDARD_RETRY,
    },
    {
      key: "validate-output",
      name: "Validate output",
      ordinal: 4,
      description: "Verify extraction invariants and recompute the digest.",
      timeoutMs: 10_000,
      retry: NO_RETRY,
    },
    {
      key: "persist-result",
      name: "Commit result",
      ordinal: 5,
      description: "Commit the verified extraction exactly once using a database constraint.",
      timeoutMs: 10_000,
      retry: STANDARD_RETRY,
    },
  ] satisfies StepPolicy[],
} as const;

export function getStepPolicy(key: DocumentStepKey): StepPolicy {
  const step = DOCUMENT_WORKFLOW.steps.find((candidate) => candidate.key === key);
  if (step === undefined) throw new Error(`Unknown step: ${key}`);
  return step;
}

export interface NormalizedDocument {
  text: string;
  characterCount: number;
  wordCount: number;
  sentenceCount: number;
  paragraphCount: number;
  readingTimeSeconds: number;
}

export interface Keyword {
  term: string;
  count: number;
}

export interface ExtractedField {
  key: string;
  value: string;
}

export interface DocumentExtraction {
  title: string;
  slug: string;
  normalized: NormalizedDocument;
  keywords: Keyword[];
  fields: ExtractedField[];
  summary: string;
  digest: string;
}

const STOPWORDS = new Set([
  "a",
  "about",
  "above",
  "after",
  "again",
  "against",
  "all",
  "and",
  "any",
  "are",
  "as",
  "at",
  "be",
  "because",
  "been",
  "before",
  "being",
  "below",
  "between",
  "both",
  "but",
  "by",
  "can",
  "could",
  "did",
  "do",
  "does",
  "doing",
  "down",
  "during",
  "each",
  "few",
  "for",
  "from",
  "further",
  "had",
  "has",
  "have",
  "having",
  "he",
  "her",
  "here",
  "hers",
  "herself",
  "him",
  "himself",
  "his",
  "how",
  "i",
  "if",
  "in",
  "into",
  "is",
  "it",
  "its",
  "itself",
  "just",
  "me",
  "more",
  "most",
  "my",
  "myself",
  "no",
  "nor",
  "not",
  "now",
  "of",
  "off",
  "on",
  "once",
  "only",
  "or",
  "other",
  "our",
  "ours",
  "ourselves",
  "out",
  "over",
  "own",
  "same",
  "she",
  "should",
  "so",
  "some",
  "such",
  "than",
  "that",
  "the",
  "their",
  "theirs",
  "them",
  "themselves",
  "then",
  "there",
  "these",
  "they",
  "this",
  "those",
  "through",
  "to",
  "too",
  "under",
  "until",
  "up",
  "very",
  "was",
  "we",
  "were",
  "what",
  "when",
  "where",
  "which",
  "while",
  "who",
  "whom",
  "why",
  "will",
  "with",
  "would",
  "you",
  "your",
  "yours",
  "yourself",
  "yourselves",
]);

export function validateDocumentInput(value: unknown): DocumentInput {
  const parsed = documentInputSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw validationError(
      issue?.message ?? "The document input is invalid.",
      "INVALID_DOCUMENT_INPUT",
    );
  }
  return parsed.data;
}

export function normalizeContent(input: DocumentInput): NormalizedDocument {
  const text = input.document
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (text.length === 0) {
    throw validationError("The document contains no usable content.", "EMPTY_DOCUMENT");
  }

  const words = tokenize(text);
  const sentences = text
    .split(/(?<=[.!?])\s+/u)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
  const paragraphs = text.split(/\n{2,}/u).filter((paragraph) => paragraph.trim().length > 0);
  const readingTimeSeconds = Math.max(1, Math.ceil((words.length / 220) * 60));

  return {
    text,
    characterCount: text.length,
    wordCount: words.length,
    sentenceCount: sentences.length,
    paragraphCount: paragraphs.length,
    readingTimeSeconds,
  };
}

export function buildSlug(title: string): string {
  return title
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

export function extractFields(text: string): ExtractedField[] {
  const fields: ExtractedField[] = [];
  const seen = new Set<string>();
  for (const line of text.split("\n")) {
    const match = /^([A-Z][A-Za-z0-9 _-]{1,40}):\s*(.+)$/u.exec(line);
    if (match === null) continue;
    const rawKey = match[1];
    const rawValue = match[2];
    if (rawKey === undefined || rawValue === undefined) continue;
    const key = rawKey.trim();
    const normalizedKey = key.toLowerCase();
    if (seen.has(normalizedKey)) continue;
    seen.add(normalizedKey);
    fields.push({ key, value: rawValue.trim().slice(0, 240) });
    if (fields.length >= 20) break;
  }
  return fields;
}

export function extractKeywords(text: string, limit = 8): Keyword[] {
  const counts = new Map<string, number>();
  for (const word of tokenize(text)) {
    const term = word.toLowerCase();
    if (term.length < 3 || STOPWORDS.has(term) || /^\d+$/u.test(term)) continue;
    counts.set(term, (counts.get(term) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([term, count]) => ({ term, count }))
    .sort((left, right) => right.count - left.count || left.term.localeCompare(right.term))
    .slice(0, limit);
}

export function buildSummary(text: string): string {
  const sentences = text
    .split(/(?<=[.!?])\s+/u)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
  const selected: string[] = [];
  let length = 0;
  for (const sentence of sentences.slice(0, 3)) {
    if (length + sentence.length > 280) break;
    selected.push(sentence);
    length += sentence.length + 1;
  }
  const summary = selected.join(" ").trim();
  return (summary.length > 0 ? summary : text.slice(0, 240).trim()).slice(0, 280);
}

export async function extractDocument(input: DocumentInput): Promise<DocumentExtraction> {
  return extractFromNormalized(input.title, normalizeContent(input));
}

export async function extractFromNormalized(
  title: string,
  normalized: NormalizedDocument,
): Promise<DocumentExtraction> {
  const keywords = extractKeywords(normalized.text);
  const fields = extractFields(normalized.text);
  const base = {
    title,
    slug: buildSlug(title),
    normalized,
    keywords,
    fields,
    summary: buildSummary(normalized.text),
  };
  const digest = await sha256Hex(canonicalExtractionPayload(base));
  return { ...base, digest };
}

export function validateExtraction(extraction: DocumentExtraction): void {
  if (extraction.title.trim().length === 0) {
    throw validationError("Extraction lost the document title.", "OUTPUT_TITLE_MISSING");
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(extraction.slug)) {
    throw validationError("Extraction produced an invalid slug.", "OUTPUT_SLUG_INVALID");
  }
  if (extraction.normalized.characterCount !== extraction.normalized.text.length) {
    throw validationError(
      "Character count does not match normalized text.",
      "OUTPUT_COUNT_MISMATCH",
    );
  }
  if (extraction.normalized.wordCount !== tokenize(extraction.normalized.text).length) {
    throw validationError("Word count does not match normalized text.", "OUTPUT_COUNT_MISMATCH");
  }
  if (extraction.normalized.wordCount < 1) {
    throw validationError("Document has no words.", "OUTPUT_EMPTY");
  }
  if (extraction.keywords.length === 0) {
    throw validationError("No keywords could be extracted.", "OUTPUT_KEYWORDS_EMPTY");
  }
  if (extraction.keywords.length > 8) {
    throw validationError("Keyword limit exceeded.", "OUTPUT_KEYWORDS_EXCESSIVE");
  }
  if (extraction.fields.length > 20) {
    throw validationError("Field limit exceeded.", "OUTPUT_FIELDS_EXCESSIVE");
  }
  for (const keyword of extraction.keywords) {
    if (keyword.count < 1 || keyword.term.length < 3) {
      throw validationError("Keyword statistics are invalid.", "OUTPUT_KEYWORD_INVALID");
    }
  }
  if (extraction.summary.length === 0 || extraction.summary.length > 280) {
    throw validationError("Summary violates its size contract.", "OUTPUT_SUMMARY_INVALID");
  }
}

/**
 * Recomputes the digest over the deterministic fields of an extraction. This is
 * used by the output-validation step to detect a corrupted or tampered result.
 */
export async function verifyExtractionDigest(extraction: DocumentExtraction): Promise<void> {
  const expected = await sha256Hex(canonicalExtractionPayload(extraction));
  if (expected !== extraction.digest) {
    throw validationError("Extraction digest verification failed.", "OUTPUT_DIGEST_MISMATCH");
  }
}

export type InjectedFault =
  | { kind: "transient"; code: string; message: string }
  | { kind: "terminal"; code: string; message: string };

/**
 * Allowlisted fault injection for the public sandbox. The scenario is chosen
 * server-side from a closed enum; clients cannot inject arbitrary failures.
 */
export function injectedFault(
  scenario: FailureScenario,
  stepKey: DocumentStepKey,
  attempt: number,
): InjectedFault | null {
  if (stepKey !== "extract-insights") return null;
  if (scenario === "retryable_failure" && attempt === 1) {
    return {
      kind: "transient",
      code: "UPSTREAM_RATE_LIMITED",
      message: "Simulated dependency rate limit (this attempt is expected to be retried).",
    };
  }
  if (scenario === "terminal_failure" && attempt === 1) {
    return {
      kind: "terminal",
      code: "DOCUMENT_UNPROCESSABLE",
      message: "Simulated permanent extraction failure: the document violates a provider policy.",
    };
  }
  return null;
}

export function faultToError(fault: InjectedFault) {
  return fault.kind === "transient"
    ? transientDependencyError(fault.message, fault.code)
    : permanentApplicationError(fault.message, fault.code);
}

function tokenize(text: string): string[] {
  return text.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? [];
}

function canonicalExtractionPayload(
  extraction: Omit<DocumentExtraction, "digest"> | DocumentExtraction,
): string {
  return JSON.stringify({
    title: extraction.title,
    slug: extraction.slug,
    text: extraction.normalized.text,
    keywords: extraction.keywords.map((keyword) => [keyword.term, keyword.count]),
    fields: extraction.fields.map((field) => [field.key, field.value]),
    summary: extraction.summary,
  });
}

export async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
