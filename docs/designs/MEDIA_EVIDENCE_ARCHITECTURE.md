# Media Evidence Architecture

Status: Draft upstream architecture note, kept as an adapter vocabulary

Audience: downstream implementers and upstream GBrain maintainers

Updated: 2026-05-08

## Why This Exists

GBrain already has strong content ingestion patterns for transcripts, documents, and searchable pages. What it does not yet have is a runtime-level architecture for treating uploaded or linked media as first-class evidence.

This document frames that gap in upstream-friendly terms:

- **media artifacts** as canonical source objects
- **media segments** as addressable subranges inside those artifacts
- **media evidence** as extracted or derived signals tied back to artifact and segment provenance
- **media resolvers** as the extraction boundary
- **match reasons** as the retrieval explanation surface

The intent is to let a downstream fork ship a practical OpenClaw extraction
adapter now without locking upstream into fork-local branding, storage choices,
or provider choices. Upstream GBrain's native image pages, file records,
multimodal embeddings, OCR, and image-aware query behavior are the canonical
long-term storage and retrieval path. `gbrain.media-extraction.v1` is the
interchange payload an adapter can hand to GBrain, not a replacement for
upstream-native media primitives.

## Problem Statement

GBrain can already ingest content into searchable pages, raw data, and files. That gets us part of the way for PDFs, screenshots, videos, and audio. But media support remains mostly page-centric rather than artifact-centric:

- there is no canonical runtime shape for an uploaded image, PDF, audio file, or video
- there is no segment-level retrieval model for pages, timestamps, regions, or clips
- extraction pipelines are implicit and tool-specific rather than exposed as stable resolver contracts
- search can return relevant text, but not yet a principled explanation of which media region matched and why

That makes fork-local MVPs possible, but it leaves upstream without a clear abstraction seam.

## Design Goals

1. Keep first user value fast.
2. Define canonical nouns early.
3. Preserve provenance for extracted claims.
4. Remain backend-agnostic.
5. Fit existing GBrain primitives.
6. Support explainable retrieval.

## Core Concepts

### Media Artifact

A media artifact is the canonical record for a binary or externally hosted source item.

Examples:

- an uploaded screenshot
- a PDF attachment
- an MP3 meeting recording
- a local video file
- a hosted YouTube URL once normalized into a tracked source object

Current adapter interchange contract: `gbrain.media-extraction.v1`.

The transitional OpenClaw adapter accepts normalized extraction payloads with
these fields:

```ts
interface MediaExtraction {
  schemaVersion: 'gbrain.media-extraction.v1';
  kind: 'image' | 'pdf' | 'video' | 'audio';
  sourceRef?: string;
  title?: string;
  summary?: string;
  caption?: string;
  ocrText?: string;
  transcriptText?: string;
  segments: MediaExtractionSegment[];
  entities?: MediaEntity[];
  tags?: MediaTag[];
  matchReasons?: MediaMatchReason[];
  metadata?: Record<string, unknown>;
}
```

Future conceptual artifact shape, non-normative:

```ts
interface MediaArtifact {
  id: string;
  kind: 'image' | 'pdf' | 'audio' | 'video' | 'document';
  sourceUrl?: string;
  fileId?: string;
  mimeType?: string;
  title?: string;
  createdAt: string;
  metadata?: Record<string, unknown>;
}
```

Mapping to today's runtime:

| Conceptual field | Current runtime field |
| --- | --- |
| `id` | `sourceRef` or `metadata.artifactId` |
| `kind` | `kind` |
| `sourceUrl` / `fileId` | `sourceRef` |
| `mimeType`, `createdAt`, extra fields | `metadata` |

### Media Segment

A media segment is an addressable subrange within a media artifact.

Examples:

- page 7 of a PDF
- timestamp 00:12:34 to 00:12:51 of a video
- a sampled keyframe at 00:05:10
- a rectangular crop inside an image
- a paragraph span in extracted OCR text

Current runtime segment contract:

```ts
interface MediaExtractionSegment {
  id: string;
  kind: 'asset' | 'page' | 'frame' | 'transcript_segment' | 'audio_segment';
  locator?: MediaLocator;
  caption?: string;
  summary?: string;
  ocrText?: string;
  transcriptText?: string;
  entities?: MediaEntity[];
  tags?: MediaTag[];
  matchReasons?: MediaMatchReason[];
  confidence?: number;
  metadata?: Record<string, unknown>;
}
```

Future conceptual segment shape, non-normative:

```ts
interface MediaSegment {
  id: string;
  artifactId: string;
  segmentType: 'page' | 'time_range' | 'frame' | 'region' | 'text_span';
  locator: Record<string, unknown>;
  textPreview?: string;
  metadata?: Record<string, unknown>;
}
```

Mapping to today's runtime:

| Conceptual field | Current runtime field |
| --- | --- |
| `id` | `segments[].id` |
| `artifactId` | top-level `sourceRef` or `segments[].metadata.artifactId` |
| `segmentType` | `segments[].kind` |
| `locator` | `segments[].locator` |
| `textPreview` | `caption`, `summary`, `ocrText`, or `transcriptText` |

### Media Evidence

Media evidence is any extracted or derived signal attached to either an artifact or a segment.

Examples:

- OCR text from a PDF page
- a caption generated for an image
- ASR transcript from an audio span
- labels/entities detected on a frame
- an embedding vector generated from a segment
- a human-authored note tied to a specific screenshot region

Current evidence output contract: `gbrain.media-evidence.v1`.

`mediaExtractionToEvidence` normalizes extraction payloads into this searchable evidence shape:

```ts
interface MediaEvidence {
  schemaVersion: 'gbrain.media-evidence.v1';
  kind: 'image' | 'pdf' | 'video' | 'audio';
  sourceRef?: string;
  text: string;
  segments: MediaExtractionSegment[];
  entities: MediaEntity[];
  tags: MediaTag[];
  matchReasons: MediaMatchReason[];
  metadata?: Record<string, unknown>;
}
```

Future conceptual evidence shape, non-normative:

```ts
interface MediaEvidence {
  id: string;
  artifactId: string;
  segmentId?: string;
  evidenceType:
    | 'ocr_text'
    | 'caption'
    | 'transcript'
    | 'summary'
    | 'entity'
    | 'embedding'
    | 'metadata';
  content?: string;
  rawDataRef?: string;
  resolverId?: string;
  confidence?: number;
  createdAt: string;
  metadata?: Record<string, unknown>;
}
```

Mapping to today's runtime:

| Conceptual field | Current runtime field |
| --- | --- |
| `id` | `metadata.evidenceId` when needed |
| `artifactId` | `sourceRef` or `metadata.artifactId` |
| `segmentId` | `segments[].id` |
| `evidenceType` | populated field name or `matchReasons[].kind` |
| `content` | `text` |
| `rawDataRef`, `resolverId`, extra fields | `metadata` |

### Media Resolver

A media resolver is the runtime boundary that turns a media artifact or media segment into media evidence.

Resolver properties should include:

- declared input and output schemas
- deterministic versus paid/provider-backed execution
- provenance metadata for every result
- optional fallback behavior

Operation-facing resolver entrypoints should remain centralized in shared operation definitions so CLI and MCP/HTTP surfaces stay generated from one source of truth.

This keeps extraction logic composable and upstreamable even if a fork starts with cloud-assisted tooling.

### Match Reason

A match reason is the user-visible explanation for why a media result appeared in search.

Examples:

- OCR text on PDF page 4 matched a query phrase.
- Video transcript at 00:01:24 mentions the searched error.
- Image caption and visual embedding both matched a whiteboard architecture query.

This should be treated as a first-class retrieval output, not an afterthought in UI copy.

## Architecture

The recommended upstream shape is additive, not disruptive.

GBrain already has strong building blocks:

- `files` for binary attachment storage
- `raw_data` for sidecar provenance
- pages and chunks for searchable text views
- hybrid search for keyword/vector retrieval
- resolver-oriented runtime direction in the Knowledge Runtime design

The key idea is that media evidence should feed existing graph/page/search primitives while preserving canonical artifact, segment, and evidence lineage underneath.

```text
input file or URL
  -> normalize into media artifact
  -> produce one or more media segments
  -> run media resolvers over artifact and/or segments
  -> emit media evidence records
  -> materialize searchable text/views into normal pages or chunks
  -> expose media-aware search results with match reasons
```

## Fork-Local MVP Versus Upstreamable Seam

### Fork-Local MVP

A downstream fork can deliver value quickly by using today's primitives:

- store original binary or URL via the existing file/storage layer or frontmatter
- create or update a normal page for the media item
- store OCR/caption/transcript/provider payloads in `raw_data`
- materialize extracted text into searchable page/chunk content
- attach lightweight frontmatter describing artifact kind and locators

This MVP is intentionally pragmatic. It may collapse artifact/evidence/page concepts together, skip dedicated segment tables, and treat match reasons as derived display logic.

### Upstreamable Seam

Even if the fork starts pragmatically, upstream should standardize the seam around:

- canonical media artifact identity
- optional media segment identity and locators
- media resolver contracts for extraction
- media evidence as the provenance-bearing derived layer
- match reasons as part of retrieval output

## Minimal Upstream Change Surface

A realistic upstream contribution should stay narrow:

1. Canonical metadata shape for media artifacts in frontmatter, operations, or API output.
2. Resolver interfaces for media extraction.
3. Optional locator-aware evidence records through a transitional raw-data-backed representation.
4. Search response extensions for media type, locator, preview hint, and match reason.
5. No mandatory provider/backend dependency.

## Explicit Non-Goals For Upstream V1

- no mandatory LanceDB/Qdrant dependency
- no forced object-store redesign
- no provider-specific resolver in the abstraction itself
- no giant UI rewrite requirement
- no fork-only brand language

## Recommended Implementation Order

### Phase A - Downstream MVP

- treat uploads/URLs as media-backed pages
- preserve original binaries or URLs
- store extraction payloads in `raw_data`
- index extracted text into ordinary search
- return basic media-aware match reasons

### Phase B - Extraction Seam Cleanup

- factor OCR/caption/transcript steps behind media resolver interfaces
- normalize artifact metadata and segment locators
- emit structured match reasons

### Phase C - Richer Evidence Model

- make segment-level evidence a clearer runtime concept
- add optional multimodal embedding backends
- support page/time-range/frame-scoped retrieval

### Phase D - Upstream Formalization

- stabilize artifact/evidence contracts
- land minimal search/result API changes
- ship docs/examples without coupling upstream to any single backend

## Bottom Line

The fork should move now, but the vocabulary should already be upstream-friendly.

The winning pattern is fork-local implementation pragmatism paired with upstream-stable runtime nouns. If we get that right, today's MVP becomes tomorrow's small, coherent upstream contribution instead of a throwaway fork subsystem.
