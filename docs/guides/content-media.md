# Content and Media Ingestion

## Thin-Fork Boundary

Upstream GBrain owns the long-term media core: native image pages, file
records, multimodal embeddings, OCR, and image-aware query behavior. Eva Brain
should use those primitives rather than keeping a separate fork-local media
storage model.

Eva's OpenClaw-specific value lives at the adapter boundary:

- `/plugins/gbrain/extract` performs OAuth-backed extraction through the
  OpenClaw/Codex runtime
- the plugin returns `gbrain.media-extraction.v1`
- GBrain core imports normalized content into pages, chunks, files, and raw
  data

The fork currently keeps these transitional compatibility commands:

- normalized media evidence JSON can be imported with `gbrain import-media`
- text-backed extraction can be bridged through `gbrain ingest-media --extract openclaw`
- image MVP extraction can use the OpenClaw gateway route at `/plugins/gbrain/extract`
- OCR, captions, transcripts, summaries, entities, tags, locators, and match reasons become searchable once they are present in that normalized payload

The `--extract openclaw` adapter prefers `GBRAIN_OPENCLAW_GATEWAY_URL` or
`OPENCLAW_GATEWAY_URL`, which calls OpenClaw's OAuth-backed Codex runtime through
`/plugins/gbrain/extract` and supports text plus the current image MVP. The
`GBRAIN_OPENCLAW_COMPLETION_COMMAND` fallback remains text-only and is meant for
local host adapters that cannot accept file media.

Do not treat `import-media` / `ingest-media` as a permanent competing GBrain
media subsystem. They are bridge commands until the OpenClaw plugin can write
the upstream-native media representation directly.

Direct binary video/audio/PDF understanding is the next adapter milestone. Keep
binary extraction behind host, resolver, or provider adapters; do not present it
as core GBrain behavior until it is live-smoked end to end.

## Goal
YouTube videos, social media, PDFs, and documents become searchable brain pages with the agent's own analysis and full cross-references to every entity mentioned.

## What the User Gets
Without this: media links are bookmarks that decay -- you remember watching a video but can't find what was said, who said it, or why it mattered. With this: every piece of media is a permanent brain page with the agent's analysis layered on top, every mentioned entity gets a back-link, and the full content is searchable forever.

## Implementation

```
on user_shares_media(url_or_file):

    # PATTERN 1: YouTube Video Ingestion
    if media.type == "youtube":
        # Step 1: Get FULL transcript with speaker diarization
        #   WHO said WHAT -- not just a wall of text
        #   Use Diarize.io or equivalent service
        transcript = diarize(video_url)  # speaker-attributed transcript
        # NEVER use YouTube's auto-generated summary or AI summary

        # Step 2: Agent writes OWN analysis (this is the value)
        #   NOT a summary. NOT regurgitation. The agent's TAKE:
        #   - What matters and why (given the user's worldview)
        #   - Key quotes attributed to specific speakers
        #   - Connections to existing brain pages
        #   - Implications and follow-up angles
        analysis = agent_analyze(transcript, user_context)

        # Step 3: Create brain page
        slug = f"media/youtube/{video_slug}"
        gbrain put <slug> --content """
            # {title}
            **Channel:** {channel} | **Date:** {date} | **Link:** {url}

            ## Analysis
            {agent_analysis}

            ## Key Quotes
            - **{Speaker}** ({timestamp}): "{quote}" -- {why_it_matters}

            ---
            ## Full Transcript
            {diarized_transcript}
        """

        # Step 4: Extract and cross-reference entities
        for person in transcript.mentioned_people:
            gbrain add_link <slug> <person_slug>
            gbrain add_link <person_slug> <slug>
            gbrain add_timeline_entry <person_slug> \
                --entry "Discussed in {video_title}: {what_was_said}" \
                --source "YouTube: {url}"

    # PATTERN 2: Social Media Bundles
    elif media.type == "tweet" or media.type == "social":
        # Don't just save a tweet -- reconstruct FULL context
        bundle = {
            "original": fetch_tweet(url),
            "thread": reconstruct_thread(url),        # quoted tweets, replies
            "linked_articles": fetch_linked_urls(),    # fetch and summarize
            "engagement": get_engagement_data(),       # what resonated
        }

        slug = f"media/social/{platform}-{author}-{date}"
        gbrain put <slug> --content """
            # {author}: {topic}
            {agent_analysis_of_full_bundle}

            ## Thread
            {reconstructed_thread}

            ## Linked Articles
            {article_summaries}

            ---
            ## Raw
            {original_tweet_text}
        """

        # Extract entities and cross-reference
        for entity in bundle.mentioned_entities:
            gbrain add_link <slug> <entity_slug>
            gbrain add_link <entity_slug> <slug>

    # PATTERN 3: PDFs and Documents
    elif media.type == "pdf" or media.type == "document":
        # OCR if needed (scanned PDFs)
        content = ocr_if_needed(file) or extract_text(file)

        # For books and long-form:
        slug = f"sources/{document_slug}"
        gbrain put <slug> --content """
            # {title}
            **Author:** {author} | **Date:** {date}

            ## Chapter Summaries
            {per_chapter_summary}

            ## Key Quotes
            - p.{page}: "{quote}" -- {why_it_matters}

            ## Cross-References
            {links_to_brain_pages_for_people_and_concepts}

            ---
            ## Source
            {full_text_or_key_sections}
        """

        for entity in document.mentioned_entities:
            gbrain add_link <slug> <entity_slug>
            gbrain add_link <entity_slug> <slug>

    # import-media / ingest-media writes searchable pages directly.
    # For separate local markdown folders, refresh with:
    gbrain import <folder> --no-embed
    gbrain embed --stale --source <source-id>
    # Use `gbrain sync --repo <repo>` only for git-tracked sources with a remote/upstream.
```

## Tricky Spots

1. **Always FULL transcript, never AI summary.** YouTube's auto-summary and AI-generated summaries lose the texture: who said what, exact phrasing, tone, what was left unsaid. The full diarized transcript is the evidence base. The agent's analysis goes above it.
2. **The agent's OWN analysis is the value, not regurgitation.** "The video discussed AI safety" is worthless. "Dario made a specific claim about compute scaling that contradicts what Ilya said in the NeurIPS talk -- see media/youtube/ilya-neurips-2025" is useful. The analysis connects the new media to the existing brain.
3. **Social media is a bundle, not a single tweet.** A tweet without its thread, quoted tweets, linked articles, and engagement context is a fragment. Reconstruct the full context before creating the brain page.
4. **Cross-references make media pages alive.** A YouTube page without back-links to the people and companies mentioned is a dead archive. Every mentioned entity gets a link and a timeline entry.
5. **Over time, `media/` becomes a searchable archive.** Every video, podcast, talk, interview, article, and tweet the user has consumed, with the agent's commentary layered on top. This is the memex at full power.

## How to Verify

1. Ingest a YouTube video. Run `gbrain get media/youtube/{slug}`. Confirm the page has: the agent's analysis (not just a summary), key quotes with speaker attribution, and the full diarized transcript.
2. Run `gbrain get_links media/youtube/{slug}`. Confirm back-links exist to brain pages for every person and company mentioned in the video.
3. Pick a person mentioned in the video. Run `gbrain get <person_slug>`. Confirm their timeline has a new entry referencing the video with specific context.
4. Ingest a tweet. Confirm the brain page includes the thread context, linked article summaries, and entity cross-references -- not just the tweet text.
5. Run `gbrain search "{topic_from_video}"`. Confirm the media page appears in search results (verifies the content is indexed and searchable).

---
*Part of the [GBrain Skillpack](../GBRAIN_SKILLPACK.md).*
