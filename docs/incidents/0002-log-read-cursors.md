# Log read cursors duplicated partial and concurrently appended output

## Symptom

An image tool result could become raw Base64 text in the chat timeline. Large
JSON events and Chinese text made corrupted event boundaries especially visible.

## Cause

The SSE cold-start paths buffered an incomplete line but advanced the file cursor
only past complete lines. The next poll read the buffered prefix a second time.

The SSE poller and the scheduler's host-log copier also advanced their cursors to
the size observed before reading. If the file grew between stat and read, the read
could include bytes beyond that size; those bytes were then read again next time.

## Correction and prevention

Both paths advance cursors by the number of bytes actually read, including bytes
held in the pending buffer. Splitting complete lines controls emission, not the
read cursor. The existing frontend hotfix separately keeps active history fetches
unmodified so their byte count remains a valid raw-log resume offset.

Behavioral regressions in `tests/test_task_log_endpoints.py` and
`tests/test_runtime.py` force these boundaries deterministically. All six new
scenarios failed before the correction and pass afterward. These tests guard the
byte-accounting behavior; a grep for one assignment alone cannot establish whether
an asynchronous reader has already consumed more bytes than its earlier stat.
