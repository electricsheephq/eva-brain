# Media Evidence

## Goal

Make screenshots, PDFs, audio, and video searchable in GBrain through canonical media artifacts, resolver-based extraction, and evidence-backed match reasons.

## Thin-Fork Boundary

Eva Brain should not grow a permanent competing media subsystem inside GBrain
core. Upstream GBrain owns native media storage and retrieval primitives:
image pages, the `files` table, multimodal embeddings, OCR, and image-aware
query surfaces.

Eva's durable responsibility is the OpenClaw adapter layer:

- the OpenClaw plugin performs OAuth-backed extraction/enrichment
- the adapter interchange payload is `gbrain.media-extraction.v1`
- core GBrain receives normalized content, files, pages, chunks, and raw data

The current fork-local MVP remains available as **transitional compatibility**:

- `import-media` imports normalized evidence JSON and materializes it into normal pages, chunks, and raw data.
- `ingest-media --extract openclaw` calls the OpenClaw plugin extraction route and imports the returned evidence.
- Search can find media-derived OCR, captions, transcripts, summaries, tags, and match reasons once they are present in the normalized payload.

Treat those commands as bridge commands while the OpenClaw plugin learns to
write upstream-native image pages/files/evidence directly. They should not be
used as evidence that Eva core owns a separate long-term media model.

This MVP does not claim direct binary video/audio/PDF understanding inside core
GBrain. Native image indexing should follow upstream GBrain primitives; binary
video/audio/PDF understanding should stay behind host, resolver, or provider
adapters until it is live-smoked end to end.

## What the User Gets

Without this: media is attached or summarized, but retrieval is fuzzy and provenance is weak. You may remember that a screenshot or PDF mattered, but not which page, frame, or transcript span matched the query.

With this: media can become a first-class searchable source with artifact lineage, segment-level evidence, and explainable search results.

## Core Model

### Media Artifact

The original source object: image, PDF, audio file, video file, or normalized external media URL.

### Media Segment

An addressable slice of the artifact: PDF page, transcript span, video time range, frame, or image region.

### Media Evidence

Derived signal linked back to artifact and segment provenance: OCR text, transcript, caption, summary, entity extraction, embeddings, metadata.

### Media Resolver

A runtime component that transforms an artifact or segment into evidence.

### Match Reason

The explanation shown to the user for why a result matched.

## Recommended Flow

```text
file or URL
  -> upstream GBrain file/image page when native support exists
  -> OpenClaw extraction adapter when OAuth-backed enrichment is needed
  -> gbrain.media-extraction.v1 interchange JSON
  -> upstream-native page/file/chunk/raw-data writes
  -> search result with provenance or match reason
```

## Fast Fork-Local MVP

If you need user value immediately through the transitional commands, keep it
simple:

1. Preserve the original binary or URL outside the normalized evidence payload.
2. Create a normal page for the media item.
3. Save OCR/caption/transcript payloads in `raw_data`.
4. Materialize extracted text into searchable content.
5. Return media-aware results with a locator and match reason when available.

This is intentionally pragmatic. It does not require a new vector backend or a
full schema redesign, and it should shrink as upstream native media support
covers more of the path.

## Upstream-Friendly Seam

Keep the runtime vocabulary stable even if the implementation starts simple:

- canonical media artifact identity
- optional media segment identity and locator
- resolver-based extraction
- media evidence as the derived layer
- match reasons in retrieval output

That gives GBrain a clean path from page-centric media ingestion to artifact-centric media retrieval.

## How To Verify

1. Import a normalized image/PDF/video evidence fixture with `gbrain import-media`.
2. Confirm the resulting page has media frontmatter and the evidence payload is stored in `raw_data`.
3. Search for a phrase found only inside the evidence text and confirm the media page appears.
4. Confirm the matched page contains a useful locator or match reason, such as page number, timestamp, region, or transcript span.
5. Confirm the page/search path still works when no multimodal vector backend is enabled.

## Related Docs

- [Media Evidence Architecture](../designs/MEDIA_EVIDENCE_ARCHITECTURE.md)
- [Content and Media Ingestion](content-media.md)
- [Provider Install Matrix](provider-install-matrix.md)
