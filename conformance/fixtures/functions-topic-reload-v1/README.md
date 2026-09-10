# Function-oriented Pub/Sub source reload

Actual pinned firebase-tools 15.22.0 Functions and its official Pub/Sub peer,
firebase-functions 7.2.5, Node 24.20.0; tiny synthetic messages only. The source
watcher is exercised by modifying its owned temporary function source, not by
manually invoking discovery. Initial delivery, addition of a second handler/topic
and delivery through updated existing handler code all succeed without restarting
either emulator. Source and driver hashes, generated publish IDs and delivered
events are retained. No general subscriber or scheduling timing claim is made.

The first diagnostic incorrectly assumed the publish message ID would equal the
delivered CloudEvent ID and timed out despite successful delivery. It is retained
separately under the capture's r1 output, not relabeled as a product failure. The
corrected capture correlates using its synthetic stage payload and retains both
IDs as observed. Assertions still require the exact payload, handler and version.

Reproduce with the committed `capture-functions-topic-reload.mjs` and the pinned
tools/SDK roots plus a fresh output directory. It stops its owned Pub/Sub child
directly, never using the upstream broad process-name kill fallback. These are
official-oracle observations, not evidence of native Fireside reload correctness.
